"""
TableConfig dataclass, config loaders, and generic extraction runner.
"""

import importlib.resources
import json
import logging
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Callable

import pandas as pd

import port.api.props as props
import port.api.d3i_props as d3i_props
from port.api.d3i_props import ExtractionResult

logger = logging.getLogger(__name__)


@dataclass
class TableConfig:
    """Full specification for a single extracted table shown in the UI.

    Parameters
    ----------
    id:
        Unique identifier for the table, used internally by the consent form.
    extractor:
        Callable with signature ``(reader, errors, **kwargs) -> pd.DataFrame``
        that extracts the data for this table.
    title:
        Human-readable table title as a ``props.Translatable`` mapping.
    description:
        Human-readable table description as a ``props.Translatable`` mapping.
    headers:
        Mapping of DataFrame column names to ``props.Translatable`` labels
        shown as column headers in the UI.
    extractor_kwargs:
        Extra keyword arguments forwarded to ``extractor`` beyond the mandatory
        ``reader`` and ``errors`` parameters.
    visualizations:
        Optional list of visualization descriptors passed directly to
        ``PropsUIPromptConsentFormTableViz``.
    variables:
        Optional list of column names to include in the extracted DataFrame.
        ``None`` (default) keeps all columns produced by the extractor.
        Column names not present in the DataFrame are silently ignored.
    """

    id: str
    extractor: Callable[..., pd.DataFrame]
    title: props.Translatable
    description: props.Translatable
    headers: dict[str, props.Translatable]
    extractor_kwargs: dict[str, Any] = field(default_factory=dict)
    visualizations: list[dict[str, Any]] = field(default_factory=list)
    variables: list[str] | None = None


def _build_config(
    raw: dict,
    registry: dict[str, Callable[..., pd.DataFrame]],
) -> list[TableConfig]:
    """Build ``TableConfig`` objects from a parsed config dict.

    Parameters
    ----------
    raw:
        Parsed configuration dict with a top-level ``"tables"`` list.
    registry:
        Mapping from extractor name strings to callable extractor functions.

    Returns
    -------
    list[TableConfig]
        One ``TableConfig`` per entry in ``raw["tables"]``.

    Raises
    ------
    KeyError
        If an entry references an extractor name not present in *registry*.
    """
    configs: list[TableConfig] = []
    for entry in raw["tables"]:
        extractor_fn = registry[entry["extractor"]]
        headers = {
            col: props.Translatable(translations)
            for col, translations in entry["headers"].items()
        }
        configs.append(TableConfig(
            id=entry["id"],
            extractor=extractor_fn,
            title=props.Translatable(entry["title"]),
            description=props.Translatable(entry["description"]),
            headers=headers,
            extractor_kwargs=entry.get("extractor_kwargs", {}),
            visualizations=_resolve_visualizations(entry),
            variables=entry.get("variables", None),
        ))
    return configs


def _resolve_visualizations(entry: dict) -> list[dict[str, Any]]:
    """Resolve the visualizations to render for a table config entry.

    The extracted DataFrame is a data source that any visualization can
    consume; the plain table grid is just one such visualization, opted in via
    a ``{"type": "grid"}`` entry in ``visualizations``.  To keep existing
    configs working without change, a grid is prepended by default.  A config
    can suppress the grid entirely - showing only its other visualizations,
    e.g. ChatGPT rendering just the ``chat_conversation`` view - by setting
    ``"show_grid": false``.  Placing an explicit ``{"type": "grid"}`` in the
    list gives full control over its position and is left untouched.

    Parameters
    ----------
    entry:
        A single table config dict from the platform config JSON.

    Returns
    -------
    list[dict[str, Any]]
        The visualization descriptors to pass to the UI.
    """
    visualizations = list(entry.get("visualizations", []))
    show_grid = entry.get("show_grid", True)
    has_grid = any(
        isinstance(vs, dict) and vs.get("type") == "grid" for vs in visualizations
    )
    if not show_grid:
        return [
            vs for vs in visualizations
            if not (isinstance(vs, dict) and vs.get("type") == "grid")
        ]
    if not has_grid:
        return [{"type": "grid"}, *visualizations]
    return visualizations



def load_port_config(
    registry: dict[str, Callable[..., pd.DataFrame]],
    platform: str,
) -> list[TableConfig]:
    """Load the config for *platform* from ``configs/<platform>_config.json``.

    Parameters
    ----------
    registry:
        Mapping from extractor name strings to callable extractor functions.
    platform:
        Platform name, e.g. ``"chatgpt"``.

    Returns
    -------
    list[TableConfig]

    Raises
    ------
    KeyError
        If a table entry references an extractor name not present in *registry*.
    """
    config_filename = f"{platform}_config.json"
    ref = importlib.resources.files("port") / "configs" / config_filename
    raw = json.loads(ref.read_text(encoding="utf-8"))
    return _build_config(raw, registry)


def run_extraction(reader, errors: Counter, config: list[TableConfig]) -> ExtractionResult:
    """Run a config-driven extraction and return non-empty tables.

    Parameters
    ----------
    reader:
        Archive reader passed as the first argument to each extractor.
    errors:
        Mutable counter that accumulates error type counts.  Updated in-place
        by individual extractors.
    config:
        List of ``TableConfig`` objects describing which extractors to run and
        how their output should be presented in the UI.

    Returns
    -------
    ExtractionResult
        Contains only non-empty tables together with the accumulated error counter.
    """
    tables = []
    for table_cfg in config:
        df = table_cfg.extractor(reader, errors, **table_cfg.extractor_kwargs)
        if table_cfg.variables is not None:
            df = df[[c for c in table_cfg.variables if c in df.columns]]
        table = d3i_props.PropsUIPromptConsentFormTableViz(
            id=table_cfg.id,
            data_frame=df,
            title=table_cfg.title,
            description=table_cfg.description,
            headers=table_cfg.headers,
            visualizations=table_cfg.visualizations if table_cfg.visualizations else None,
        )
        tables.append(table)

    return ExtractionResult(
        tables=[t for t in tables if not t.data_frame.empty],
        errors=errors,
    )
