"""Run coordinator — bus-native scheduler replacing LangGraph in Phase 2."""

from coordinator.store import RunRecord, RunStore, get_run_store, set_run_store

__all__ = ["RunRecord", "RunStore", "execute_run", "get_run_store", "set_run_store"]


def __getattr__(name: str):
    if name == "execute_run":
        from coordinator.runner import execute_run

        return execute_run
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
