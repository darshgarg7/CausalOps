"""Constraint-based causal structure discovery over compiled evidence.

This module makes the causal DAG *emerge from the data* instead of being
trusted as hypothesized. It runs a PC-style discovery pass over the compiled
evidence dataframe:

1. Skeleton: an undirected edge survives between two variables only when they
   are dependent marginally AND given every single conditioning variable
   (chi-square / G-tests; conditioning sets of size <= 1, which is exact for
   graphs of up to ~4 variables and a sound approximation above that).
2. Orientation: colliders (v-structures) X -> Z <- Y are oriented whenever X
   and Z are adjacent, Y and Z are adjacent, X and Y are not, and Z did not
   separate X from Y.
3. Validation: every hypothesized edge receives a verdict — ``confirmed``
   (skeleton + orientation agree), ``compatible`` (dependence supported, the
   data cannot orient, hypothesis direction is adopted), ``reversed`` (the
   data orients the opposite way), or ``refuted`` (the variables are
   independent). Dependencies found in the data but absent from the
   hypothesis surface as ``discovered``.

Everything here is deterministic statistics — no LLM involvement — so the
verdicts cannot be steered by the model that authored the hypothesis.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from itertools import combinations
from typing import Any

import pandas as pd
from scipy.stats import chi2 as chi2_dist

logger = logging.getLogger(__name__)

DEFAULT_ALPHA = float(os.getenv("HIVEMIND_DISCOVERY_ALPHA", "0.1"))
MIN_ROWS_FOR_DISCOVERY = int(os.getenv("HIVEMIND_DISCOVERY_MIN_ROWS", "30"))


@dataclass
class EdgeVerdict:
    """Data-driven verdict for one directed edge."""

    source: str
    target: str
    status: str  # confirmed | compatible | reversed | refuted | discovered
    p_value: float | None = None
    strength: float | None = None  # Cramér's V of the marginal association
    detail: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "target": self.target,
            "status": self.status,
            "p_value": self.p_value,
            "strength": self.strength,
            "detail": self.detail,
        }


@dataclass
class DiscoveryReport:
    """Outcome of one discovery + validation pass."""

    performed: bool
    n_rows: int
    alpha: float
    skeleton: list[tuple[str, str]] = field(default_factory=list)
    oriented: list[tuple[str, str]] = field(default_factory=list)
    verdicts: list[EdgeVerdict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "performed": self.performed,
            "n_rows": self.n_rows,
            "alpha": self.alpha,
            "skeleton": [list(pair) for pair in self.skeleton],
            "oriented": [list(pair) for pair in self.oriented],
            "verdicts": [v.as_dict() for v in self.verdicts],
            "warnings": self.warnings,
        }


def discover_and_validate(
    df: pd.DataFrame,
    hypothesized_edges: list[dict[str, Any]],
    *,
    alpha: float | None = None,
    min_rows: int | None = None,
) -> DiscoveryReport:
    """Discover the DAG skeleton/orientations from data and judge each hypothesis."""

    alpha = DEFAULT_ALPHA if alpha is None else alpha
    min_rows = MIN_ROWS_FOR_DISCOVERY if min_rows is None else min_rows
    n_rows = len(df)

    report = DiscoveryReport(performed=False, n_rows=n_rows, alpha=alpha)
    if n_rows < min_rows:
        report.warnings.append(
            f"Causal discovery skipped: {n_rows} rows < {min_rows} minimum. "
            "The hypothesized DAG is used unvalidated."
        )
        return report

    binned, dropped = _binarize(df)
    if dropped:
        report.warnings.append(
            "Constant columns excluded from discovery: " + ", ".join(sorted(dropped))
        )
    variables = list(binned.columns)
    if len(variables) < 2:
        report.warnings.append(
            "Causal discovery skipped: fewer than two non-constant variables."
        )
        return report

    report.performed = True

    # --- Phase 1: skeleton via (conditional) independence tests -------------
    adjacent: set[frozenset[str]] = set()
    sepsets: dict[frozenset[str], set[str]] = {}
    marginal: dict[frozenset[str], tuple[float, float]] = {}  # (p, cramers_v)

    for x, y in combinations(variables, 2):
        pair = frozenset((x, y))
        p, v = _marginal_test(binned, x, y)
        marginal[pair] = (p, v)
        if p > alpha:
            sepsets[pair] = set()
            continue
        separated = False
        for z in variables:
            if z in (x, y):
                continue
            p_cond = _conditional_test(binned, x, y, z)
            if p_cond is not None and p_cond > alpha:
                sepsets[pair] = {z}
                separated = True
                break
        if not separated:
            adjacent.add(pair)

    report.skeleton = sorted(tuple(sorted(pair)) for pair in adjacent)

    # --- Phase 2: collider orientation --------------------------------------
    directed: set[tuple[str, str]] = set()
    for z in variables:
        neighbors = [v for v in variables if frozenset((v, z)) in adjacent]
        for x, y in combinations(neighbors, 2):
            pair = frozenset((x, y))
            if pair in adjacent:
                continue  # x and y are themselves adjacent: not a v-structure
            if z in sepsets.get(pair, set()):
                continue  # z separated x from y: z is a chain/fork, not a collider
            directed.add((x, z))
            directed.add((y, z))

    report.oriented = sorted(directed)

    # --- Phase 3: verdicts ----------------------------------------------------
    hypothesized_pairs: set[frozenset[str]] = set()
    for edge in hypothesized_edges:
        src = str(edge.get("source", ""))
        tgt = str(edge.get("target", ""))
        pair = frozenset((src, tgt))
        hypothesized_pairs.add(pair)

        if src not in variables or tgt not in variables:
            report.verdicts.append(
                EdgeVerdict(
                    src, tgt, "compatible", detail="Variable not measured; untestable."
                )
            )
            continue

        p, strength = marginal[pair]
        if pair not in adjacent:
            sep = sepsets.get(pair, set())
            detail = (
                f"Independent given {sorted(sep)} (alpha={alpha})."
                if sep
                else f"Marginally independent (p={p:.4f}, alpha={alpha})."
            )
            report.verdicts.append(
                EdgeVerdict(src, tgt, "refuted", p, strength, detail)
            )
        elif (src, tgt) in directed:
            report.verdicts.append(
                EdgeVerdict(
                    src,
                    tgt,
                    "confirmed",
                    p,
                    strength,
                    "Dependence and collider orientation both match the data.",
                )
            )
        elif (tgt, src) in directed:
            report.verdicts.append(
                EdgeVerdict(
                    tgt,
                    src,
                    "reversed",
                    p,
                    strength,
                    f"Data orients {tgt} -> {src}, opposite to the hypothesis.",
                )
            )
        else:
            report.verdicts.append(
                EdgeVerdict(
                    src,
                    tgt,
                    "compatible",
                    p,
                    strength,
                    "Dependence supported; direction adopted from the hypothesis.",
                )
            )

    for pair in adjacent - hypothesized_pairs:
        x, y = sorted(pair)
        p, strength = marginal[pair]
        if (x, y) in directed:
            src, tgt = x, y
        elif (y, x) in directed:
            src, tgt = y, x
        else:
            src, tgt = x, y  # unoriented: reported, but not added to the DAG
        oriented = (src, tgt) in directed
        report.verdicts.append(
            EdgeVerdict(
                src,
                tgt,
                "discovered",
                p,
                strength,
                "Oriented by collider structure."
                if oriented
                else "Dependence found in data; direction undetermined.",
            )
        )

    return report


def apply_discovery(
    graph_def: dict[str, Any], report: DiscoveryReport
) -> dict[str, Any]:
    """Return a validated copy of ``graph_def`` with data-driven edge statuses.

    Refuted edges are kept but marked ``status: refuted`` (consumers such as
    the estimator must exclude them — see :func:`estimation_edges`), reversed
    edges are flipped, and oriented discovered edges are added. Every edge
    carries ``status``/``p_value``/``strength`` so downstream consumers (the
    5D graph, the UI) can distinguish evidence-backed structure from
    assumption. If the validated edge set would contain a cycle, the original
    hypothesized structure is kept and a warning is recorded.
    """

    validated = dict(graph_def)
    original_edges = [dict(e) for e in graph_def.get("edges", [])]
    if not report.performed:
        for edge in original_edges:
            edge.setdefault("status", "hypothesized")
        validated["edges"] = original_edges
        return validated

    verdict_by_pair = {frozenset((v.source, v.target)): v for v in report.verdicts}
    edges: list[dict[str, Any]] = []

    for edge in original_edges:
        pair = frozenset((str(edge.get("source")), str(edge.get("target"))))
        verdict = verdict_by_pair.get(pair)
        if verdict is None:
            edge["status"] = "hypothesized"
            edges.append(edge)
            continue
        edge["status"] = verdict.status
        edge["p_value"] = verdict.p_value
        edge["strength"] = verdict.strength
        edge["validation_detail"] = verdict.detail
        if verdict.status == "reversed":
            edge["source"], edge["target"] = verdict.source, verdict.target
        edges.append(edge)

    known_pairs = {
        frozenset((str(e.get("source")), str(e.get("target")))) for e in edges
    }
    for verdict in report.verdicts:
        if verdict.status != "discovered":
            continue
        if frozenset((verdict.source, verdict.target)) in known_pairs:
            continue
        if (verdict.source, verdict.target) not in report.oriented:
            continue  # only add discovered edges whose direction the data fixed
        edges.append(
            {
                "source": verdict.source,
                "target": verdict.target,
                "relationship": "Discovered from evidence by independence testing.",
                "required_evidence": [],
                "falsification_tests": [],
                "status": "discovered",
                "p_value": verdict.p_value,
                "strength": verdict.strength,
                "validation_detail": verdict.detail,
            }
        )

    if _has_cycle(estimation_edges({"edges": edges})):
        report.warnings.append(
            "Validated DAG contained a cycle; keeping the hypothesized structure."
        )
        for edge in original_edges:
            edge.setdefault("status", "hypothesized")
        validated["edges"] = original_edges
        return validated

    validated["edges"] = edges
    return validated


def estimation_edges(graph_def: dict[str, Any]) -> list[dict[str, Any]]:
    """Edges that should participate in effect estimation (refuted ones excluded)."""

    return [
        edge for edge in graph_def.get("edges", []) if edge.get("status") != "refuted"
    ]


# --- statistics -------------------------------------------------------------


def _binarize(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """Coerce columns to binary via median split; drop constant columns."""

    out = {}
    dropped = []
    for col in df.columns:
        series = pd.to_numeric(df[col], errors="coerce").dropna()
        if series.nunique() <= 1:
            dropped.append(col)
            continue
        if series.nunique() == 2:
            values = sorted(series.unique())
            out[col] = (series == values[1]).astype(int)
        else:
            out[col] = (series > series.median()).astype(int)
    return pd.DataFrame(out).dropna().astype(int), dropped


def _g_statistic(table: pd.DataFrame) -> tuple[float, int]:
    """Likelihood-ratio (G) statistic and degrees of freedom for one table."""

    import math

    total = table.values.sum()
    if total == 0:
        return 0.0, 0
    g = 0.0
    row_sums = table.sum(axis=1)
    col_sums = table.sum(axis=0)
    for i in table.index:
        for j in table.columns:
            observed = table.loc[i, j]
            expected = row_sums[i] * col_sums[j] / total
            if observed > 0 and expected > 0:
                g += observed * math.log(observed / expected)
    df_table = (len(table.index) - 1) * (len(table.columns) - 1)
    return 2.0 * g, df_table


def _marginal_test(df: pd.DataFrame, x: str, y: str) -> tuple[float, float]:
    """G-test of independence between x and y; returns (p_value, Cramér's V)."""

    table = pd.crosstab(df[x], df[y])
    g, dof = _g_statistic(table)
    if dof <= 0:
        return 1.0, 0.0
    p = float(chi2_dist.sf(g, dof))
    n = len(df)
    min_dim = min(len(table.index), len(table.columns)) - 1
    cramers_v = (g / (n * min_dim)) ** 0.5 if n > 0 and min_dim > 0 else 0.0
    return p, float(min(cramers_v, 1.0))


def _conditional_test(df: pd.DataFrame, x: str, y: str, z: str) -> float | None:
    """Stratified G-test of x ⊥ y | z. Returns None when untestable."""

    g_total = 0.0
    dof_total = 0
    for _, stratum in df.groupby(z):
        if len(stratum) < 2:
            continue
        table = pd.crosstab(stratum[x], stratum[y])
        g, dof = _g_statistic(table)
        g_total += g
        dof_total += dof
    if dof_total <= 0:
        return None
    return float(chi2_dist.sf(g_total, dof_total))


def _has_cycle(edges: list[dict[str, Any]]) -> bool:
    """Detect a directed cycle via iterative DFS."""

    graph: dict[str, list[str]] = {}
    for edge in edges:
        graph.setdefault(str(edge.get("source")), []).append(str(edge.get("target")))

    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {}
    for start in list(graph):
        if color.get(start, WHITE) != WHITE:
            continue
        stack: list[tuple[str, int]] = [(start, 0)]
        color[start] = GRAY
        while stack:
            node, idx = stack[-1]
            children = graph.get(node, [])
            if idx < len(children):
                stack[-1] = (node, idx + 1)
                child = children[idx]
                state = color.get(child, WHITE)
                if state == GRAY:
                    return True
                if state == WHITE:
                    color[child] = GRAY
                    stack.append((child, 0))
            else:
                color[node] = BLACK
                stack.pop()
    return False
