"""Steady-state island evolution for CausalOps agent policy priors.

The evolutionary pass keeps the LLM-authored agent objectives intact and evolves
compact policy traits around them. Those traits are then injected into prompts as
priors, so the swarm can improve coordination and search behavior without
mutating the operational task itself.
"""

from __future__ import annotations

import hashlib
import random
import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Any, TypeVar

from bus.events import ArtifactType
from bus.helpers import bind_from_state
from bus.publish import publish_artifact, publish_telemetry
from schema import AgentConfig, AgentPolicy, ChildConfig

ConfigT = TypeVar("ConfigT", AgentConfig, ChildConfig)

TRAIT_NAMES = (
    "evidence_weight",
    "causal_focus",
    "temporal_awareness",
    "exploration",
    "exploitation",
    "risk_aversion",
    "coordination",
    "resource_budget",
)

_WORD_RE = re.compile(r"[a-z0-9_]+")


@dataclass(frozen=True)
class _Genome:
    config_index: int
    tier: str
    persona: str
    focus_objective: str
    island_id: str
    generation: int
    traits: dict[str, float]
    mutation_rate: float
    fitness: float
    lineage: tuple[str, ...]


def evolve_parent_configs(
    state: dict[str, Any],
    configs: Sequence[AgentConfig],
) -> tuple[list[AgentConfig], dict[str, Any]]:
    """Evolve parent-agent policy priors with a steady-state island EA."""

    return _evolve_configs(state, list(configs), tier="parent")


def evolve_child_configs(
    state: dict[str, Any],
    configs: Sequence[ChildConfig],
) -> tuple[list[ChildConfig], dict[str, Any]]:
    """Evolve child-agent policy priors with a steady-state island EA."""

    return _evolve_configs(state, list(configs), tier="child")


def merge_evolution_reports(
    existing: dict[str, Any] | None,
    phase_report: dict[str, Any],
) -> dict[str, Any]:
    """Merge one tier's evolution report into the run-level report."""

    report = dict(existing or {})
    phases = list(report.get("phases") or [])
    phases.append(phase_report)
    report["algorithm"] = "steady_state_island_evolution"
    report["phases"] = phases
    report["latest_phase"] = phase_report.get("tier")
    report["total_evolved_agents"] = sum(
        len(phase.get("selected_policies") or []) for phase in phases
    )
    return report


def publish_evolution_phase(
    state: dict[str, Any],
    phase_report: dict[str, Any],
) -> None:
    """Publish an evolution report phase to Kafka and telemetry."""

    bind_from_state(state)
    tier = str(phase_report.get("tier", "agent"))
    selected = phase_report.get("selected_policies") or []
    publish_telemetry(
        agent_id="optimizer:evolution",
        tier="optimizer",
        phase="AGENT_EVOLUTION",
        message=f"Evolved {len(selected)} {tier} agent policy priors",
        status="done",
    )
    publish_artifact(
        agent_id="optimizer:evolution",
        tier="optimizer",
        artifact_type=ArtifactType.AGENT_EVOLUTION_REPORT,
        payload=phase_report,
    )


def _evolve_configs(
    state: dict[str, Any],
    configs: list[ConfigT],
    *,
    tier: str,
) -> tuple[list[ConfigT], dict[str, Any]]:
    if not configs:
        return configs, _empty_report(tier)

    run_id = str(state.get("run_id", "run"))
    task_description = str(state.get("task_description", ""))
    ideal = _task_ideal(task_description)
    island_count = _bounded_int(
        state.get("evolution_islands"), default=3, low=1, high=6
    )
    population_per_config = _bounded_int(
        state.get("evolution_population_per_config"), default=3, low=2, high=8
    )
    generations = _bounded_int(
        state.get("evolution_generations"), default=8, low=2, high=40
    )
    migration_interval = _bounded_int(
        state.get("evolution_migration_interval"), default=3, low=1, high=20
    )

    rng = random.Random(_stable_int(f"{run_id}:{tier}:islands"))
    islands = _initial_islands(
        configs,
        tier=tier,
        task_description=task_description,
        ideal=ideal,
        island_count=island_count,
        population_per_config=population_per_config,
    )

    migration_events = 0
    replacements = 0
    config_indices = list(range(len(configs)))
    for generation in range(1, generations + 1):
        for _island_id, population in islands.items():
            target_index = rng.choice(config_indices)
            candidates = [
                genome for genome in population if genome.config_index == target_index
            ]
            parent_a = _tournament(candidates, rng)
            parent_b = _tournament(candidates, rng)
            child = _offspring(
                parent_a,
                parent_b,
                generation=generation,
                rng=rng,
                task_description=task_description,
                ideal=ideal,
            )
            replacement_indexes = [
                i
                for i, genome in enumerate(population)
                if genome.config_index == target_index
            ]
            worst_i = min(
                replacement_indexes,
                key=lambda i: population[i].fitness,
            )
            population[worst_i] = child
            replacements += 1

        if island_count > 1 and generation % migration_interval == 0:
            migration_events += _migrate(islands, generation=generation)

    selected_by_index: dict[int, _Genome] = {}
    for population in islands.values():
        for genome in population:
            current = selected_by_index.get(genome.config_index)
            if current is None or genome.fitness > current.fitness:
                selected_by_index[genome.config_index] = genome

    evolved_configs: list[ConfigT] = []
    selected_policies: list[dict[str, Any]] = []
    for index, config in enumerate(configs):
        genome = selected_by_index[index]
        policy = _policy_from_genome(genome, run_id=run_id)
        evolved = config.model_copy(update={"policy": policy})
        evolved_configs.append(evolved)
        selected_policies.append(
            {
                "agent": _agent_ref(tier, config),
                "persona": config.persona,
                "policy": policy.model_dump(),
            }
        )

    best = max(selected_by_index.values(), key=lambda genome: genome.fitness)
    report = {
        "algorithm": "steady_state_island_evolution",
        "tier": tier,
        "island_count": island_count,
        "population_per_config": population_per_config,
        "generations": generations,
        "migration_interval": migration_interval,
        "replacement_events": replacements,
        "migration_events": migration_events,
        "trait_names": list(TRAIT_NAMES),
        "task_trait_target": ideal,
        "best_fitness": round(best.fitness, 4),
        "selected_policies": selected_policies,
        "islands": [
            {
                "island_id": island_id,
                "population_size": len(population),
                "best_fitness": round(max(g.fitness for g in population), 4),
                "mean_fitness": round(
                    sum(g.fitness for g in population) / len(population), 4
                ),
            }
            for island_id, population in islands.items()
        ],
    }
    return evolved_configs, report


def _initial_islands(
    configs: Sequence[ConfigT],
    *,
    tier: str,
    task_description: str,
    ideal: dict[str, float],
    island_count: int,
    population_per_config: int,
) -> dict[str, list[_Genome]]:
    islands: dict[str, list[_Genome]] = {}
    for island_index in range(island_count):
        island_id = f"{tier}-island-{island_index + 1}"
        population: list[_Genome] = []
        for config_index, config in enumerate(configs):
            for slot in range(population_per_config):
                seed_key = (
                    f"{tier}:{config_index}:{config.persona}:{island_index}:{slot}"
                )
                traits = _seed_traits(
                    config.persona,
                    config.focus_objective,
                    task_description,
                    ideal,
                    seed_key,
                )
                if slot:
                    traits = _mutate_traits(
                        traits,
                        rng=random.Random(_stable_int(seed_key)),
                        mutation_rate=0.12,
                    )
                fitness = _fitness(config, traits, task_description, ideal)
                population.append(
                    _Genome(
                        config_index=config_index,
                        tier=tier,
                        persona=config.persona,
                        focus_objective=config.focus_objective,
                        island_id=island_id,
                        generation=0,
                        traits=traits,
                        mutation_rate=0.08 + 0.02 * island_index,
                        fitness=fitness,
                        lineage=(f"seed:{config.persona}",),
                    )
                )
        islands[island_id] = population
    return islands


def _offspring(
    parent_a: _Genome,
    parent_b: _Genome,
    *,
    generation: int,
    rng: random.Random,
    task_description: str,
    ideal: dict[str, float],
) -> _Genome:
    config_parent = parent_a if parent_a.fitness >= parent_b.fitness else parent_b
    traits: dict[str, float] = {}
    for name in TRAIT_NAMES:
        a = parent_a.traits[name]
        b = parent_b.traits[name]
        if rng.random() < 0.35:
            value = a
        elif rng.random() < 0.7:
            value = b
        else:
            value = (a + b) / 2.0
        traits[name] = value
    mutation_rate = (parent_a.mutation_rate + parent_b.mutation_rate) / 2.0
    traits = _mutate_traits(traits, rng=rng, mutation_rate=mutation_rate)
    fitness = _fitness(config_parent, traits, task_description, ideal)
    return replace(
        config_parent,
        generation=generation,
        traits=traits,
        mutation_rate=mutation_rate,
        fitness=fitness,
        lineage=(
            *config_parent.lineage[-3:],
            f"crossover:{parent_a.persona}+{parent_b.persona}",
        ),
    )


def _migrate(
    islands: dict[str, list[_Genome]],
    *,
    generation: int,
) -> int:
    island_ids = list(islands)
    best_by_island = [
        max(islands[island_id], key=lambda genome: genome.fitness)
        for island_id in island_ids
    ]
    events = 0
    for index, migrant in enumerate(best_by_island):
        destination = island_ids[(index + 1) % len(island_ids)]
        population = islands[destination]
        replacement_indexes = [
            i
            for i, genome in enumerate(population)
            if genome.config_index == migrant.config_index
        ]
        if not replacement_indexes:
            continue
        worst_i = min(replacement_indexes, key=lambda i: population[i].fitness)
        if migrant.fitness <= population[worst_i].fitness:
            continue
        population[worst_i] = replace(
            migrant,
            island_id=destination,
            generation=generation,
            lineage=(*migrant.lineage[-3:], f"migration:{destination}"),
        )
        events += 1
    return events


def _policy_from_genome(genome: _Genome, *, run_id: str) -> AgentPolicy:
    policy_key = (
        f"{run_id}:{genome.tier}:{genome.persona}:"
        f"{genome.island_id}:{genome.generation}:{genome.fitness:.4f}"
    )
    digest = hashlib.sha256(policy_key.encode("utf-8")).hexdigest()[:10]
    return AgentPolicy(
        policy_id=f"{genome.tier}.{_slug(genome.persona)}.{digest}",
        island_id=genome.island_id,
        generation=genome.generation,
        traits={key: round(value, 4) for key, value in genome.traits.items()},
        mutation_rate=round(genome.mutation_rate, 4),
        fitness=round(genome.fitness, 4),
        lineage=list(genome.lineage[-5:]),
        objective_hint=_objective_hint(genome.traits),
    )


def _fitness(
    config: AgentConfig | ChildConfig | _Genome,
    traits: dict[str, float],
    task_description: str,
    ideal: dict[str, float],
) -> float:
    persona = str(getattr(config, "persona", ""))
    objective = str(getattr(config, "focus_objective", ""))
    agent_tokens = _tokens(f"{persona} {objective}")
    task_tokens = _tokens(task_description)
    overlap = len(agent_tokens & task_tokens) / max(1, len(agent_tokens | task_tokens))
    specificity = min(1.0, len(agent_tokens) / 18.0)
    evidence_terms = {"evidence", "telemetry", "logs", "siem", "edr", "cve", "graph"}
    evidence_alignment = min(1.0, len(agent_tokens & evidence_terms) / 2.0)
    trait_error = sum(abs(traits[name] - ideal[name]) for name in TRAIT_NAMES) / len(
        TRAIT_NAMES
    )
    trait_balance = 1.0 - trait_error
    coordination_bonus = (traits["coordination"] + traits["causal_focus"]) / 2.0
    fitness = (
        0.28 * overlap
        + 0.22 * specificity
        + 0.14 * evidence_alignment
        + 0.28 * trait_balance
        + 0.08 * coordination_bonus
    )
    return max(0.0, min(1.0, fitness))


def _seed_traits(
    persona: str,
    objective: str,
    task_description: str,
    ideal: dict[str, float],
    seed_key: str,
) -> dict[str, float]:
    text = f"{persona} {objective} {task_description}".lower()
    traits = dict(ideal)
    if any(word in text for word in ("forensic", "log", "telemetry", "evidence")):
        traits["evidence_weight"] = max(traits["evidence_weight"], 0.82)
    if any(word in text for word in ("causal", "confound", "root", "effect")):
        traits["causal_focus"] = max(traits["causal_focus"], 0.82)
    if any(word in text for word in ("live", "stream", "kafka", "temporal")):
        traits["temporal_awareness"] = max(traits["temporal_awareness"], 0.8)
    if any(word in text for word in ("risk", "contain", "response", "incident")):
        traits["risk_aversion"] = max(traits["risk_aversion"], 0.72)

    seeded: dict[str, float] = {}
    for name in TRAIT_NAMES:
        jitter = _stable_float(f"{seed_key}:{name}", -0.18, 0.18)
        seeded[name] = _clamp(0.72 * traits[name] + 0.28 * (0.5 + jitter))
    return seeded


def _mutate_traits(
    traits: dict[str, float],
    *,
    rng: random.Random,
    mutation_rate: float,
) -> dict[str, float]:
    mutated = dict(traits)
    for name in TRAIT_NAMES:
        if rng.random() <= 0.72:
            mutated[name] = _clamp(
                mutated[name] + rng.uniform(-mutation_rate, mutation_rate)
            )
    return mutated


def _task_ideal(task_description: str) -> dict[str, float]:
    text = task_description.lower()
    ideal = {
        "evidence_weight": 0.72,
        "causal_focus": 0.72,
        "temporal_awareness": 0.55,
        "exploration": 0.48,
        "exploitation": 0.62,
        "risk_aversion": 0.58,
        "coordination": 0.68,
        "resource_budget": 0.55,
    }
    if any(word in text for word in ("kafka", "stream", "dynamic", "real-time")):
        ideal["temporal_awareness"] = 0.84
        ideal["coordination"] = 0.76
    if any(word in text for word in ("causal", "graph", "dag", "confound")):
        ideal["causal_focus"] = 0.86
    if any(word in text for word in ("uncertain", "unknown", "blind spot", "novel")):
        ideal["exploration"] = 0.72
    if any(word in text for word in ("contain", "incident", "risk", "breach")):
        ideal["risk_aversion"] = 0.74
    if any(word in text for word in ("urgent", "fast", "latency")):
        ideal["exploitation"] = 0.76
        ideal["resource_budget"] = 0.68
    return ideal


def _tournament(population: Sequence[_Genome], rng: random.Random) -> _Genome:
    size = min(3, len(population))
    return max(rng.sample(list(population), k=size), key=lambda genome: genome.fitness)


def _tokens(text: str) -> set[str]:
    return {token for token in _WORD_RE.findall(text.lower()) if len(token) > 2}


def _stable_int(text: str) -> int:
    return int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:12], 16)


def _stable_float(text: str, low: float, high: float) -> float:
    value = _stable_int(text) / float(0xFFFFFFFFFFFF)
    return low + (high - low) * value


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _bounded_int(value: Any, *, default: int, low: int, high: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(low, min(high, parsed))


def _agent_ref(tier: str, config: AgentConfig | ChildConfig) -> str:
    if tier == "child":
        return f"agent.child.{_slug(config.persona)}"
    return f"agent.parent.{_slug(config.persona)}"


def _objective_hint(traits: dict[str, float]) -> str:
    top = sorted(traits.items(), key=lambda item: item[1], reverse=True)[:3]
    return ", ".join(name.replace("_", " ") for name, _ in top)


def _slug(value: str) -> str:
    return value.replace(" ", "_").lower()


def _empty_report(tier: str) -> dict[str, Any]:
    return {
        "algorithm": "steady_state_island_evolution",
        "tier": tier,
        "island_count": 0,
        "population_per_config": 0,
        "generations": 0,
        "migration_interval": 0,
        "replacement_events": 0,
        "migration_events": 0,
        "trait_names": list(TRAIT_NAMES),
        "task_trait_target": {},
        "best_fitness": 0.0,
        "selected_policies": [],
        "islands": [],
    }
