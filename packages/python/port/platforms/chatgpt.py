"""
ChatGPT

This module provides an example flow of a ChatGPT data donation study

Assumptions:
It handles DDPs in the english language with filetype JSON.

Configuration
-------------
The ``extraction`` function is driven by ``port_config.json``.  Generate one with::

    pnpm generate-config chatgpt

Each extractor function carries its own table config in a ``Table config::``
JSON block inside its docstring.  The generator reads those blocks and
assembles the JSON file.

Platform info::

    {
        "name": "ChatGPT",
        "filetypes": ["json"],
        "languages": ["en", "nl"],
        "description": "Handles DDPs in English. These data donation flows have not been tested yet, if you find anything wrong with them report to datadonation@uu.nl and they will be fixed!",
        "time_last_tested": "not yet implemented"
    }
"""
import json
import logging
from collections import Counter
from typing import Callable

import pandas as pd

import port.helpers.extraction_helpers as eh
import port.helpers.validate as validate
from port.helpers.extraction_helpers import ZipArchiveReader
from port.helpers.flow_builder import FlowBuilder

from port.helpers.validate import (
    DDPCategory,
    DDPFiletype,
    Language,
)
from port.api.d3i_props import ExtractionResult
from port.helpers.table_extractor import (
    load_port_config,
    run_extraction,
)
import port.helpers.redact as redact

logger = logging.getLogger(__name__)

DDP_CATEGORIES = [
    DDPCategory(
        id="json",
        ddp_filetype=DDPFiletype.JSON,
        language=Language.EN,
        known_files=[
            "chat.html",
            "conversations.json",
            "message_feedback.json",
            "model_comparisons.json",
            "user.json"
        ]
    )
]


def conversations_to_df(reader: ZipArchiveReader, errors: Counter) -> pd.DataFrame:
    """Extract all ChatGPT conversations into a DataFrame.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during
        extraction.  Updated in-place.

    Returns
    -------
    pd.DataFrame
        Columns: ``conversation title``, ``role``, ``message``, ``model``, ``time``, ``message id``, ``reaction to``, ``content references``, ``search_result_groups``.
        Empty DataFrame when the file is absent or parsing fails.

    Table documentation::

        {
          "summary": "Each row represents one message turn in a ChatGPT conversation, including the role (user or assistant), the message text, the model used, and the timestamp.",
          "source_file": "conversations files (conversations-000.json, conversations-001.json, ... or conversations.json)",
          "columns": {
            "conversation title": "Title of the conversation as stored in the export.",
            "role": "Role of the message author: 'user' or 'assistant'.",
            "message": "Full text of the message.",
            "model": "ChatGPT model slug used to generate the assistant reply.",
            "time": "ISO 8601 timestamp of when the message was created.",
            "message id": "A unique identifier for the message.",
            "reaction to": "The id of the message this message reacts to. ``client-created-root`` indicates the first message in the chat.",
            "content references": "Contains content items that are referenced in the message.",
            "search_result_groups": "Contains the web search result groups (sources) used to ground the message, if any."
          }
        }

    Table config::

        {
          "id": "chatgpt_conversations",
          "show_grid": false,
          "title": {
            "en": "1. Your conversations",
            "nl": "1. Uw gesprekken"
          },
          "description": {
            "en": "Below you find your conversations with ChatGPT. You can review the content of a conversation by clicking on it. You can also search through the conversations by typing in the search box, selecting a period in the timeline, or clicking on words in the word cloud. See the help buttons for each component for further explanation.",
            "nl": "Hieronder vindt u uw gesprekken met ChatGPT. U kunt de inhoud van een gesprek bekijken door erop te klikken. U kunt ook door de gesprekken zoeken door iets in het zoekvak te typen, een periode in de tijdlijn te selecteren of op woorden in de woordwolk te klikken. Zie de helpknoppen voor elk onderdeel voor meer uitleg."
          },
          "headers": {
            "conversation title": {"en": "Conversation title", "nl": "Gesprektitel"},
            "role": {"en": "Role", "nl": "Rol"},
            "message": {"en": "Message", "nl": "Bericht"},
            "model": {"en": "Model", "nl": "Model"},
            "time": {"en": "Time", "nl": "Tijd"},
            "message id": {"en": "ID", "nl": "ID"},
            "reaction to": {"en": "Reaction to", "nl": "Reactie op"},
            "content references": {"en": "Content references", "nl": "Content referenties"},
            "search_result_groups": {"en": "Search result groups", "nl": "Zoekresultaatgroepen"}
          },
          "visualizations": [
            {
              "title": {
                "en": "Your conversations",
                "nl": "Uw gesprekken"
              },
              "type": "chat_conversation",
              "roleColumn": "role",
              "messageColumn": "message",
              "modelColumn": "model",
              "timestampColumn": "time",
              "titleColumn": "conversation title",
              "referencesColumn": "content references",
              "sourcesColumn": "search_result_groups",
              "idColumn": "message id",
              "reactionToColumn": "reaction to",
              "height": 500
            },
            {
              "title": {
                "en": "Your messages over time",
                "nl": "Uw berichten door de tijd"
              },
              "type": "calendar_heatmap",
              "dateColumn": "time",
              "row": 1
            },
            {
              "title": {
                "en": "Your messages in a wordcloud",
                "nl": "Je berichten in een woordwolk"
              },
              "type": "wordcloud",
              "textColumn": "message",
              "tokenize": true,
              "row": 1
            }
          ]
        }
    """
    results = reader.json_all(r"conversations.*\.json")
    if not results:
        return pd.DataFrame()
    conversations = [conv for result in results for conv in result.data]

    datapoints = []
    out = pd.DataFrame()

    try:
        for conversation in conversations:
            title = conversation["title"]
            for id, turn in conversation["mapping"].items():

                content_references = []
                if isinstance(turn.get('message'), dict):
                    if isinstance(turn['message'].get('metadata'), dict):
                        content_references = turn['message']['metadata'].get('content_references', [])
                
                search_result_groups = []
                if isinstance(turn.get('message'), dict):
                    if isinstance(turn['message'].get('metadata'), dict):
                        search_result_groups = turn['message']['metadata'].get('search_result_groups', [])

                denested_d = eh.dict_denester(turn)
                is_hidden = eh.find_item(denested_d, "is_visually_hidden_from_conversation")
                if is_hidden != "True":
                    role = eh.find_item(denested_d, "role")
                    message = "".join(eh.find_items(denested_d, "part"))
                    model = eh.find_item(denested_d, "-model_slug")
                    reaction_to = eh.find_item(denested_d, "parent")
                    time = eh.epoch_to_iso(eh.find_item(denested_d, "create_time"), errors=errors)
                    datapoint = {
                        "conversation title": title,
                        "role": role,
                        "message": redact.redact(message),
                        "model": model,
                        "time": time,
                        "message id": id,
                        "reaction to": reaction_to,
                        "content references": redact.redact(json.dumps(content_references)),
                        "search_result_groups": redact.redact(json.dumps(search_result_groups)),
                    }
                    if role != "":
                        datapoints.append(datapoint)

        out = pd.DataFrame(datapoints)

    except Exception as e:
        logger.error("Data extraction error: %s", e)
        errors[type(e).__name__] += 1

    return out


# ---------------------------------------------------------------------------
# Extractor registry & platform info
# ---------------------------------------------------------------------------

#: Mapping from the string names used in port_config.json to actual extractor functions.
EXTRACTOR_REGISTRY: dict[str, Callable[..., pd.DataFrame]] = {
    "conversations_to_df": conversations_to_df,
}


# ---------------------------------------------------------------------------
# Main extraction & flow
# ---------------------------------------------------------------------------

def extraction(chatgpt_zip: str, validation) -> ExtractionResult:
    """Extract data from a ChatGPT DDP zip and return consent-form tables.

    Parameters
    ----------
    chatgpt_zip:
        Path to the ChatGPT DDP zip archive on disk.
    validation:
        Validation result object whose ``archive_members`` attribute is passed
        to ``ZipArchiveReader``.
    """
    config = load_port_config(EXTRACTOR_REGISTRY, "chatgpt")
    errors: Counter = Counter()
    reader = ZipArchiveReader(chatgpt_zip, validation.archive_members, errors)
    return run_extraction(reader, errors, config)


class ChatGPTFlow(FlowBuilder):
    """Flow implementation for the ChatGPT data donation study."""

    def __init__(self, session_id: str):
        super().__init__(session_id, "ChatGPT")

    def validate_file(self, file):
        return validate.validate_zip(DDP_CATEGORIES, file)

    def extract_data(self, file_value, validation):
        return extraction(file_value, validation)


def process(session_id):
    flow = ChatGPTFlow(session_id)
    return flow.start_flow()
