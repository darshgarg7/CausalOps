"""Normalize external cyber records into HiveMind evidence contracts.

These adapters are deliberately export-based: they accept records from SIEM
queries, CVE feed pulls, and incident-report systems without requiring live
tenant credentials in the demo. The normalized output can be passed directly to
`/estimate` or `/run` as `evidence_records`.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator
from typing import Any

from dataset_compiler import clean_variable
from schema import EvidenceRecord

SENTINEL_ASSET_KEYS = ("Computer", "DeviceName", "HostName", "AssetId", "ResourceId")
SENTINEL_USER_KEYS = ("Account", "UserPrincipalName", "InitiatingProcessAccountName")
SENTINEL_EVENT_KEYS = ("AlertName", "Activity", "EventID", "OperationName", "Type")
SENTINEL_TIME_KEYS = ("TimeGenerated", "Timestamp", "EventTime", "CreatedTime")
SENTINEL_TECHNIQUE_KEYS = ("TechniqueId", "TechniqueID", "MITRETechnique", "Tactic")
CVE_ID_KEYS = ("cve_id", "cveId", "CVE", "id")


def normalize_sentinel_records(
    records: Iterable[dict[str, Any]],
    source_name: str = "microsoft-sentinel-export",
) -> Iterator[dict[str, Any]]:
    """Normalize Microsoft Sentinel or SIEM-like export rows."""

    for index, record in enumerate(records or []):
        yield EvidenceRecord(
            source_type="siem",
            source_name=source_name,
            observed_at=_first(record, SENTINEL_TIME_KEYS),
            asset_id=_first(record, SENTINEL_ASSET_KEYS),
            user_id=_first(record, SENTINEL_USER_KEYS),
            event_type=_first(record, SENTINEL_EVENT_KEYS),
            technique_id=_first(record, SENTINEL_TECHNIQUE_KEYS),
            cve_id=_first(record, CVE_ID_KEYS),
            severity=_severity_to_float(_first(record, ("Severity", "AlertSeverity"))),
            raw_text=_safe_json(record),
            raw_ref=str(
                _first(record, ("SystemAlertId", "EventID", "_ItemId")) or index
            ),
            extracted_fields=_field_aliases(record),
        ).model_dump()


def normalize_cve_records(
    records: Iterable[dict[str, Any]],
    source_name: str = "cve-feed-export",
) -> Iterator[dict[str, Any]]:
    """Normalize NVD/CVE-style feed records."""

    for index, record in enumerate(records or []):
        cve_id = _extract_cve_id(record)
        yield EvidenceRecord(
            source_type="cve",
            source_name=source_name,
            observed_at=str(
                _first(record, ("published", "publishedDate", "lastModified")) or ""
            )
            or None,
            event_type="cve_observed",
            cve_id=cve_id,
            severity=_extract_cvss_score(record),
            raw_text=_extract_description(record) or _safe_json(record),
            raw_ref=cve_id or f"cve-record-{index}",
            extracted_fields=_field_aliases(record),
        ).model_dump()


def normalize_incident_reports(
    records: Iterable[dict[str, Any]],
    source_name: str = "incident-report-export",
) -> Iterator[dict[str, Any]]:
    """Normalize case-management or analyst incident report rows."""

    for index, record in enumerate(records or []):
        title = _first(record, ("title", "Title", "incident_title", "name"))
        body = _first(record, ("body", "Body", "summary", "description", "notes"))
        yield EvidenceRecord(
            source_type="incident_report",
            source_name=source_name,
            observed_at=_first(record, ("observed_at", "created_at", "ClosedTime")),
            asset_id=_first(record, ("asset_id", "host", "device", "service")),
            user_id=_first(record, ("user_id", "user", "owner", "account")),
            event_type=str(title or "incident_report"),
            technique_id=_first(record, SENTINEL_TECHNIQUE_KEYS),
            cve_id=_first(record, CVE_ID_KEYS),
            severity=_severity_to_float(_first(record, ("severity", "priority"))),
            raw_text=str(body or title or record),
            raw_ref=str(_first(record, ("id", "case_id", "incident_id")) or index),
            extracted_fields=_field_aliases(record),
        ).model_dump()


def _field_aliases(record: dict[str, Any]) -> dict[str, Any]:
    """Preserve original fields and sanitized aliases for measurement lookup."""

    fields: dict[str, Any] = {}
    for key, value in record.items():
        text_key = str(key)
        fields[text_key] = value
        fields[clean_variable(text_key)] = value
    return fields


def _first(record: dict[str, Any], keys: tuple[str, ...]) -> Any:
    """Return the first present value across case-sensitive and lower keys."""

    lowered = {str(key).lower(): value for key, value in record.items()}
    for key in keys:
        if key in record and record[key] not in (None, ""):
            return record[key]
        value = lowered.get(key.lower())
        if value not in (None, ""):
            return value
    return None


def _severity_to_float(value: Any) -> float | None:
    """Convert common textual severity labels to numeric scores."""

    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        pass

    severity_map = {
        "critical": 9.5,
        "high": 8.0,
        "medium": 5.0,
        "moderate": 5.0,
        "low": 2.0,
        "informational": 0.5,
        "info": 0.5,
    }
    return severity_map.get(str(value).strip().lower())


def _extract_cve_id(record: dict[str, Any]) -> str | None:
    """Extract a CVE identifier from flat or NVD nested records."""

    flat = _first(record, CVE_ID_KEYS)
    if flat and not isinstance(flat, dict | list):
        return str(flat)

    nested = record.get("cve")
    if not isinstance(nested, dict) and isinstance(flat, dict):
        nested = flat
    if isinstance(nested, dict):
        nested_id = _first(nested, CVE_ID_KEYS)
        return str(nested_id) if nested_id else None
    return None


def _extract_cvss_score(record: dict[str, Any]) -> float | None:
    """Extract a CVSS score from common NVD metric layouts."""

    direct = _severity_to_float(_first(record, ("cvss", "cvssScore", "baseScore")))
    if direct is not None:
        return direct

    metrics = record.get("metrics")
    if not isinstance(metrics, dict):
        return None
    for family in ("cvssMetricV31", "cvssMetricV30", "cvssMetricV2"):
        entries = metrics.get(family) or []
        if entries and isinstance(entries[0], dict):
            cvss_data = entries[0].get("cvssData") or {}
            score = _severity_to_float(cvss_data.get("baseScore"))
            if score is not None:
                return score
    return None


def _extract_description(record: dict[str, Any]) -> str | None:
    """Extract an English description from common CVE feed structures."""

    descriptions = record.get("descriptions")
    if isinstance(descriptions, list):
        for item in descriptions:
            if isinstance(item, dict) and item.get("lang") == "en":
                return str(item.get("value", ""))

    nested = record.get("cve")
    if isinstance(nested, dict):
        return _extract_description(nested)
    return None


def _safe_json(record: dict[str, Any]) -> str:
    """Serialize records for raw-text provenance without failing on objects."""

    return json.dumps(record, default=str, ensure_ascii=False)
