"""
TikTok

This module contains an example flow of a TikTok data donation study.

Assumptions:
It handles DDPs in the English or Dutch language, either with filetype JSON or a compressed folder with TXT files.

Configuration
-------------
The ``extraction`` function is driven by ``port_config.json``.  Generate one with::

    pnpm generate-config tiktok

Each extractor function carries its own table config in a ``Table config::``
JSON block inside its docstring.  The generator reads those blocks and
assembles the JSON file.

Platform info::

    {
        "name": "TikTok",
        "filetypes": ["json", "txt"],
        "languages": ["en", "nl"],
        "description": "Handles DDPs in English and Dutch. For the JSON format, both user_data.json and user_data_tiktok.json are tried automatically. English DDPs in TXT format have not yet been tested. If you find anything wrong with the data donation flows, please report to datadonation@uu.nl and they will be fixed!",
        "time_last_tested": "15-06-2026"
    }
"""

import ast
import ast
from csv import reader
import io
import json
import logging
from collections import Counter
import re
from typing import Any, Callable

import pandas as pd

import port.helpers.extraction_helpers as eh
import port.helpers.port_helpers as ph
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

logger = logging.getLogger(__name__)

DDP_CATEGORIES = [
    DDPCategory(
        id="json_en",
        ddp_filetype=DDPFiletype.JSON,
        language=Language.EN,
        known_files=[
            "user_data.json",
            "user_data_tiktok.json",
        ],
    ),
    DDPCategory(
        id="txt_nl",
        ddp_filetype=DDPFiletype.TXT,
        language=Language.NL,
        known_files=[
            "Locatierecensies.txt","Instellingen voor LIVE bekijken.txt",
            "Geschiedenis van LIVE gaan.txt","Reactie op livestream.txt",
            "Geschiedenis van LIVE bekijken.txt","Instellingen voor LIVE gaan.txt",
            "Geschiedenis van Muntaankopen.txt","Transactiegeschiedenis.txt",
            "Reacties.txt","Informatie over huidige betaling.txt",
            "Geschiedenis van klantenservice.txt","Bestelgeschiedenis.txt",
            "Favoriet item.txt","Communicatie met winkels.txt","Productrecensies.txt",
            "Vouchers.txt","Geschiedenis van bladeren door producten.txt",
            "Geschiedenis van bestelkwesties.txt",
            "Geschiedenis van retourzendingen en terugbetalingen.txt",
            "Opgeslagen adresgegevens.txt","Winkelwagenlijst.txt",
            "Favoriete films en tv-programma's.txt","Favoriete video's.txt",
            "Favoriete hashtags.txt","Favoriete afspeellijsten.txt",
            "Favoriete effecten.txt","Likelijst.txt","Favoriete geluiden.txt",
            "Favoriete collecties.txt","Favoriete plaatsen.txt",
            "Favoriete reacties.txt","Volger.txt","Informatie van derden.txt",
            "Volgend.txt","Blokkeringslijst.txt","AI-moji.txt","Instellingen.txt",
            "Profielweergaven.txt","Automatisch invullen.txt","Profielinformatie.txt",
            "Inloggeschiedenis.txt","Activiteit buiten TikTok.txt",
            "Herplaatsingen.txt","Donatie.txt","Samenvatting van activiteit.txt",
            "Fondsenwerving.txt","Geschiedenis van advertentielinks.txt","Hashtag.txt",
            "Stickers.txt","Meest recente locatiegegevens.txt","Aankopen.txt",
            "Advertentie-interesses.txt","Reacties op direct formulier-advertenties.txt",
            "Geschiedenis delen.txt","Status.txt","Kijkgeschiedenis.txt",
            "Zoekopdrachten.txt","Groepschat.txt","Berichten.txt",
            "Onlangs verwijderde berichten.txt","Directe berichten.txt",
        ],
    ),
    DDPCategory(
        id="txt_en",
        ddp_filetype=DDPFiletype.TXT,
        language=Language.EN,
        known_files=[
            "Comments.txt","Recently Deleted Posts.txt","Posts.txt","Favorite Videos.txt",
            "Like List.txt","Favorite Sounds.txt","Favorite HashTags.txt",
            "Favorite Places.txt","Favorite Effects.txt","Favorite Comments.txt",
            "Favorite Collections.txt","Searches.txt","Ad Interests.txt",
            "Most Recent Location Data.txt","Activity Summary.txt","Watch History.txt",
            "Off TikTok Activity.txt","Donation.txt","Share History.txt","Hashtag.txt",
            "Stickers.txt","Purchases.txt","Login History.txt","Reposts.txt","Status.txt",
            "Instant Form Ads Responses.txt","Fundraiser.txt","Settings.txt","Follower.txt",
            "Following.txt", "Ad Link History.txt", "FavoriteItems.txt", "FavouriteItems.txt" 
            "Product Browsing History.txt", "Shopping Cart List.txt", "Order History.txt", 
            "Vouchers.txt", "Favourite Videos.txt"
        ],
    )   
]


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def _load_user_data(reader: ZipArchiveReader) -> dict:
    """Load the TikTok export root JSON from the DDP zip."""
    for filename in ("user_data_tiktok.json", "user_data.json"):
        result = reader.json(filename)
        if result.found and isinstance(result.data, dict) and result.data:
            return result.data
    return {}


def _get(d: dict, *keys: str | list[str]):
    """
    Navigate a nested dict, trying each key in order at each level.
    Accepts multiple variant names per level as a list or single string.
    """
    node = d
    for key in keys:
        if not isinstance(node, dict):
            return None
        if isinstance(key, (list, tuple)):
            for k in key:
                if k in node:
                    node = node[k]
                    break
            else:
                return None
        else:
            node = node.get(key)
    return node


def _get_first(d: dict, *paths: tuple[str | list[str], ...]):
    """Return the first non-None result across multiple candidate paths."""
    for path in paths:
        node = _get(d, *path)
        if node != None:
            return node
    return None


def _item_get(item: dict, *keys: str):
    """Read the first present key from a record, handling case variants."""
    for key in keys:
        if key in item:
            return item.get(key)
        lower = key.lower()
        if lower in item:
            return item.get(lower)
    return ""


def _parse_tiktok_txt(data: io.BytesIO | list[str]) -> dict[str, Any] | list[dict[str, Any]] | None:
    """Read structured TikTok data in txt format and parse it into a 1) flat dictionary,
    2) list of dictionaries, or 3) nested dictionary, depending on the file structure."""

    if isinstance(data, io.BytesIO):
        lines = [line.decode("utf-8") for line in data.readlines()]
    else:
        lines = data

    # Strip trailing blank lines
    while lines and lines[-1].strip() == "":
        lines.pop()
    
    # Check if file is empty or only contains a line indicating it is empty
    if not lines or (len(lines) == 1 and _is_empty_sentinel(lines[0])):
        return None

    blocks = _split_into_blocks(lines)

    # Need at least one block with key-value pairs to continue
    if not blocks:
        return None

    # 1. Single block case: return a single flat dictionary
    if len(blocks) == 1 and _block_only_kv(blocks[0]):    
        return _parse_kv_block(blocks[0])

    # 2. List of records case: multiple blocks with identical keys should return a list of dictionaries
    if len(blocks) >= 2 and _block_only_kv(blocks[0]) and _block_only_kv(blocks[1]):
        keys_0 = {line.partition(":")[0].strip() for line in blocks[0]}
        keys_1 = {line.partition(":")[0].strip() for line in blocks[1]}
        if keys_0 == keys_1:
            records: list[dict[str, Any]] = [] # Every block with these same keys is a record
            for blk in blocks:
                if _block_only_kv(blk): # Only include blocks with key-value pairs
                    blk_keys = {line.partition(":")[0].strip() for line in blk}
                    if blk_keys == keys_0: # Only include blocks with the same keys as the first two
                        records.append(_parse_kv_block(blk))
                    else: # Keys diverged, fall back to generic parsing
                        break
                else: # Not a key-value block, fall back to generic parsing
                    break
            else:
                return records

    # 3. Other cases: generic (nested) parsing
    # Blocks with a first line without ':' or ending with ':' without a subsequent value 
    # are treated as section headers, opening a nested dictionary that is populated with
    # the key-value pairs in the following lines until the next section header or end 
    # of the block. All other key-value lines are added to the current context, while 
    # other non key-value lines are ignored.
    result: dict[str, Any] = {}
    for block in blocks:
        section_name = None
        start_line = 0
        if (':' not in block[0] or block[0].strip().endswith(":")) and len(block) > 1: # First line is a section header -> make a nested dict for this block
            if ':' in block[1] or _is_empty_sentinel(block[1]): # Only treat as section header if there is content left in this block
                section_name = block[0].strip()
                result[section_name] = {}
                start_line = 1
        for line in block[start_line:]:
            if ':' in line:
                key, _, raw_value = line.partition(":")
                key = key.strip()
                value = _parse_value(raw_value)
                if section_name is not None:
                    result[section_name][key] = value
                else:
                    result[key] = value
            elif len(line.strip()) > 0 and not _is_empty_sentinel(line): # New section header found, starting new nested dict for subsequent key-value pairs
                section_name = line.strip()
                result[section_name] = {}
            else:
                continue #ignore non key-value lines that are not section headers
    return result


def _split_into_blocks(lines: list[str]) -> list[list[str]]:
    """Split a list of lines into *blocks* separated by one or more blank lines.
    Trailing empty blocks are discarded."""
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        if line.strip() == "":
            if current:
                blocks.append(current)
                current = []
        else:
            current.append(line)
    if current:
        blocks.append(current)
    return blocks


def _is_empty_sentinel(line: str) -> bool:
    """Return True if *line* is a known empty-data placeholder."""
    _EMPTY_SENTINELS = {
        "dit gedeelte bevat geen gegevens",
        "er staan geen gegevens in dit gedeelte",
        "je hebt geen informatie over platforms van derden",
        "You have no data in this section",        
    }
    return line.strip().lower() in _EMPTY_SENTINELS


def _block_only_kv(block: list[str]) -> bool:
    """Return True when every line looks like 'key: <value>'."""
    return all([':' in line for line in block])


def _parse_kv_block(block: list[str]) -> dict[str, Any]:
    """Parse a block of lines in 'key: value' format into a dictionary, coercing
    values to richer types where possible."""
    result = {}
    for line in block:
        if ":" not in line:
            continue
        key, _, raw_value = line.partition(":") #note that any ':' in the value (e.g. for time) are perserved in raw_value
        key = key.strip()
        value = _parse_value(raw_value)
        result[key] = value
    return result


def _parse_value(raw: str) -> Any:
    """Coerce a raw string value coming from a TXT key-value line into a
    richer Python type where appropriate."""
    s = raw.strip()
    # 1. Empty list literal
    if s == "[]":
        return []
    # 2. Non-empty bracketed list (e.g. "[a, b, c]" or "[{a: 1}, {b: 2}]")
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        if inner == "":
            return []
        return [_parse_list_item(item) for item in _split_top_level(inner)]
    # 3. Null-like sentinels
    if s.lower() in {"n/a", "n.v.t.", "none"}:
        return None
    # 4. Integer
    try:
        return int(s)
    except ValueError:
        pass
    return s


def _parse_list_item(item: str) -> Any:
    """Coerce a single item of a bracketed list.  Dict-shaped items become
    dicts, everything else keeps its raw string form."""
    s = item.strip()
    if s.startswith("{") and s.endswith("}"):
        return _parse_dict(s)
    return s


def _parse_dict(s: str) -> Any:
    """Parse a Python-style dict literal into a dict.

    Well-formed literals (quoted keys and values, nested structures, ``None``,
    booleans, numbers) are read with :func:`ast.literal_eval`.  TXT exports also
    write dicts without quotes (e.g. "{a: 1, b: n.v.t.}"), so anything
    ``literal_eval`` rejects falls back to a lenient split whose values are
    coerced by :func:`_parse_value` in turn.  Returns the original string when
    the content is not key-value shaped."""
    try:
        parsed = ast.literal_eval(s)
    except (ValueError, SyntaxError):
        pass
    else:
        if isinstance(parsed, dict):
            return parsed
    inner = s[1:-1].strip()
    if inner == "":
        return {}
    result: dict[str, Any] = {}
    for entry in _split_top_level(inner):
        if ":" not in entry:
            return s  # not key-value shaped -> keep the raw string
        key, _, raw_value = entry.partition(":")
        value = _parse_value(raw_value)
        if isinstance(value, str):
            value = _strip_quotes(value)
        result[_strip_quotes(key)] = value
    return result


def _split_top_level(s: str, sep: str = ",") -> list[str]:
    """Split *s* on *sep*, ignoring separators nested inside brackets, braces or
    quotes.  Returned parts are stripped."""
    parts: list[str] = []
    current: list[str] = []
    depth = 0
    quote: str | None = None
    for char in s:
        if quote is not None:
            current.append(char)
            if char == quote:
                quote = None
            continue
        if char in "'\"":
            quote = char
            current.append(char)
            continue
        if char in "[{(":
            depth += 1
        elif char in "]})":
            depth = max(depth - 1, 0)
        if char == sep and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    return [part.strip() for part in parts]


def _strip_quotes(s: str) -> str:
    """Remove one layer of matching surrounding quotes from *s*."""
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"":
        return s[1:-1]
    return s


# ---------------------------------------------------------------------------
# Extractor functions
# ---------------------------------------------------------------------------

def activity_summary_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok activity summary counts.

    Reads ``Activity > Activity Summary > ActivitySummaryMap`` from the TikTok
    export JSON or from ``Samenvatting van activiteit.txt`` or ``Activity Summary.txt``
    in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during
        extraction.  Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Metric``, ``Count``.
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::

        {
          "summary": "Summary counts of TikTok activity measures since account registration, such as the number of videos watched, commented on, and shared.",
          "source_file": "user_data_tiktok.json, user_data.json, Activity Summary.txt or Samenvatting van activiteit.txt",
          "columns": {
            "Metric": "Name of the activity metric",
            "Count": "Total count for that metric since account registration."
          }
        }

    Table config::

        {
          "id": "tiktok_activity_summary",
          "title": {
            "en": "Your TikTok activity summary",
            "nl": "Samenvatting van je TikTok-activiteit"
          },
          "description": {
            "en": "Summary counts of videos watched, commented on, and shared since account registration.",
            "nl": "Overzicht van het aantal bekeken, becommentarieerde en gedeelde video's sinds registratie."
          },
          "headers": {
            "Metric": {"en": "Activity metric", "nl": "Activiteitsmaat"},
            "Count": {"en": "Count", "nl": "Aantal"}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            summary = _get(
                data,
                ["Activity", "Your Activity"],
                "Activity Summary",
                "ActivitySummaryMap",
            )
            if not isinstance(summary, dict):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Samenvatting van activiteit.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Activity Summary.txt")
        else:
            return out
        if not data.found:
            return out
        try:
            summary = _parse_tiktok_txt(data.data)
            if len(summary) == 0:
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    else:
        return out
    try:
        metric_priority = [
            ("Videos watched since registration", ["videoCount"]),
            ("Videos watched to the end since registration", ["videosWatchedToTheEndSinceAccountRegistration", "Videos watched to the end since account registration", "Video's tot het einde bekeken sinds accountregistratie"]),
            ("Videos commented on since registration", ["videosCommentedOnSinceAccountRegistration", "commentVideoCount", "Videos commented on since account registration", "Video's waarop is gereageerd sinds accountregistratie"]),
            ("Videos shared since registration", ["videosSharedSinceAccountRegistration", "sharedVideoCount", "Videos shared since account registration", "Video's gedeeld sinds accountregistratie"]),
        ]
        rows = []
        for label, keys in metric_priority:
            for key in keys:
                if key in summary:
                    rows.append((label, summary[key]))
                    break
        out = pd.DataFrame(rows, columns=["Metric", "Count"])  # pyright: ignore
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def ad_link_history_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok ad link history.

    Reads ``Activity > Ad Link History > AdLinkHistoryList`` from the TikTok
    export JSON or from ``Geschiedenis van advertentielinks.txt`` or 
    ``Ad Link History.txt`` in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during
        extraction.  Updated in-place.
    validation: 
        Validation results for the extracted data used to determine ddp type and language.
    
    Returns
    -------
    pd.DataFrame
        Columns: ``Date``, ``Title``, ``Link``.
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::

        {
          "summary": "Each row represents one TikTok advertisement the participant was shown, including the date, title, and URL of the ad.",
          "source_file": "user_data_tiktok.json, user_data.json, Ad Link History.txt or Geschiedenis van advertentielinks.txt",
          "columns": {
            "Date": "Date of the ad link click",
            "Title": "Title of the ad",
            "Link": "URL of the ad link"
          }
        }

    Table config::

        {
          "id": "tiktok_ad_link_history",
          "title": {
            "en": "Your TikTok ad link history",
            "nl": "Je TikTok advertentielinkgeschiedenis"
          },
          "description": {
            "en": "List of advertisements that were shown, including the date, title, and URL of each ad.",
            "nl": "Lijst van advertenties die zijn getoond, inclusief de datum, titel en URL van elke advertentie."
          },
          "headers": {
            "Date": {"en": "Date", "nl": "Datum"},
            "Title": {"en": "Title", "nl": "Titel"},
            "Link": {"en": "Link", "nl": "Link"}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get(
                data,
                ["Activity", "Your Activity"],
                ["Ads Visit History"],
                "AdsVisitHistoryList",
            )
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Geschiedenis van advertentielinks.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Ads Link History.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            items = _parse_tiktok_txt(data.data)
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
                
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    else:
        return out    
    try:
        rows = [(_item_get(item, "CreateTime", "Create Date", "Aanmaakdatum"), _item_get(item, "AdLink", "Ad Link", "Advertentielink"), _item_get(item, "AdTitle","Ad Title", "Advertentietitel")) for item in items]
        out = pd.DataFrame(rows, columns=["Date", "Link", "Title"])  # pyright: ignore
        out = out.sort_values("Date", ascending=False)
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out




def settings_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok content preference keyword filters.

    Reads ``App Settings > Settings > SettingsMap`` from the TikTok export JSON 
    or from ``Instellingen.txt`` or ``Settings.txt`` in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during
        extraction.  Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Setting``, ``Value``.
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::

        {
          "summary": "Keyword filters applied to the participant's TikTok feeds.",
          "source_file": "user_data_tiktok.json, user_data.json, Settings.txt or Instellingen.txt",
          "columns": {
            "Setting": "Name of the content preference setting.",
            "Value": "Configured value for this setting."
          }
        }

    Table config::

        {
          "id": "tiktok_settings",
          "title": {
            "en": "Content preference keyword filters",
            "nl": "Zoekwoordfilters voor contentvoorkeuren"
          },
          "description": {
            "en": "Keyword filters applied to your Following and For You feeds.",
            "nl": "Zoekwoordfilters die worden toegepast op je Volgend- en Voor Jou-feeds."
          },
          "headers": {
            "Setting": {"en": "Setting", "nl": "Instelling"},
            "Value": {"en": "Value", "nl": "Waarde"}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            settings_map = _get(
                data,
                ["App Settings", "Profile And Settings"],
                "Settings",
                "SettingsMap",
            )
            if not isinstance(settings_map, dict):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Instellingen.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Settings.txt")
        else:
            return out
        if not data.found:
            return out
        try:
            settings_map = _parse_tiktok_txt(data.data)
            if len(settings_map) == 0:
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    else:
        return out
    try:
        rows = []
        denested = eh.dict_denester(settings_map)
        field_map = {
            "Keyword filters for videos in Following feed": "Keyword filter for videos in the Following feed",
            "Keyword filters for videos in For You feed": "Keyword filters for videos in For You feed",
            "Trefwoordfilters voor video's in de 'Volgend'-feed": "Keyword filter for videos in the Following feed",
            "Trefwoordfilters voor video's in de 'Voor jou'-feed": "Keyword filters for videos in For You feed",
            "App Language": "App Language",
            "App-taal": "App Language",
            "Personalised Ads": "Personalised Ads",
            "Personalized Ads": "Personalised Ads",
            "Gepersonaliseerde advertenties": "Personalised Ads",
        }
        for k,v in field_map.items():
            item = eh.find_item(denested, k)
            if item != '':
                rows.append((v, item))
        out = pd.DataFrame(rows, columns=["Setting", "Value"])  # pyright: ignore
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def watch_history_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok video watch history.

    Reads ``Activity > Video Browsing History > VideoList`` from the TikTok 
    export JSON or from ``Kijkgeschiedenis.txt`` or ``Watch History.txt`` in 
    case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during
        extraction.  Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Date``, ``Link``.
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::

        {
          "summary": "Each row represents one TikTok video the participant watched, including the date and video link.",
          "source_file": "user_data_tiktok.json, user_data.json, Watch History.txt or Kijkgeschiedenis.txt",
          "columns": {
            "Date": "Timestamp of when the video was watched.",
            "Link": "URL of the watched TikTok video."
          }
        }

    Table config::

        {
          "id": "tiktok_watch_history",
          "title": {"en": "Watch history", "nl": "Kijkgeschiedenis"},
          "description": {
            "en": "TikTok videos you have watched.",
            "nl": "TikTok-video's die je hebt bekeken."
          },
          "headers": {
            "Date": {"en": "Date", "nl": "Datum en tijd"},
            "Link": {"en": "Link", "nl": "URL"}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get(
                data,
                ["Activity", "Your Activity"],
                ["Video Browsing History", "Watch History"],
                "VideoList",
            )
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Kijkgeschiedenis.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Watch History.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            items = _parse_tiktok_txt(data.data)
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
                
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    else:
        return out    
    try:
        rows = [(_item_get(item, "Date", "Datum"), _item_get(item, "Link")) for item in items]
        out = pd.DataFrame(rows, columns=["Date", "Link"])  # pyright: ignore
        out = out.sort_values("Date", ascending=False)
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def favorite_videos_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok favorite videos.

    Reads ``Activity > Favorite Videos > FavoriteVideoList`` from the TikTok
    export JSON or from ``Favoriete video's.txt``, ``Favorite Videos.txt`` or 
    ``Favourite Videos.txt`` in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during
        extraction.  Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Date``, ``Link``.
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::

        {
          "summary": "Each row represents one TikTok video the participant marked as a favorite.",
          "source_file": "user_data_tiktok.json, user_data.json, Favorite Videos.txt, Favourite Videos.txt or Favoriete video's.txt",
          "columns": {
            "Date": "Timestamp of when the video was marked as favorite.",
            "Link": "URL of the favorited TikTok video."
          }
        }

    Table config::

        {
          "id": "tiktok_favorite_videos",
          "title": {"en": "Favorite videos", "nl": "Favoriete video's"},
          "description": {
            "en": "Videos you have marked as favorites on TikTok.",
            "nl": "Video's die je als favoriet hebt gemarkeerd op TikTok."
          },
          "headers": {
            "Date": {"en": "Date", "nl": "Datum en tijd"},
            "Link": {"en": "Link", "nl": "URL"}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get_first(
                data,
                (["Activity", "Your Activity"], "Favorite Videos", "FavoriteVideoList"),
                ("Likes and Favorites", "Favorite Videos", "FavoriteVideoList"),
            )
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Favoriete video's.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Favorite Videos.txt")
            if not data.found:
                data = reader.raw("Favourite Videos.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            items = _parse_tiktok_txt(data.data)
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    try:
        rows = [(_item_get(item, "Date", "Datum"), _item_get(item, "Link")) for item in items]
        out = pd.DataFrame(rows, columns=["Date", "Link"])  # pyright: ignore
        out = out.sort_values("Date", ascending=False)
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def following_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok following list.

    Reads ``Activity > Following List > Following`` from the TikTok export JSON
    or from ``Volgend.txt`` or ``Following.txt`` in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during
        extraction.  Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Date``, ``UserName``.
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::

        {
          "summary": "Each row represents one account that the participant follows on TikTok.",
          "source_file": "user_data_tiktok.json, user_data.json, Following.txt or Volgend.txt",
          "columns": {
            "Date": "Timestamp of when the participant started following this account.",
            "UserName": "Username of the followed account."
          }
        }

    Table config::

        {
          "id": "tiktok_following",
          "title": {"en": "Accounts you follow", "nl": "Accounts die je volgt"},
          "description": {
            "en": "Accounts you follow on TikTok.",
            "nl": "Accounts die je volgt op TikTok."
          },
          "headers": {
            "Date": {"en": "Date", "nl": "Datum en tijd"},
            "UserName": {"en": "Username", "nl": "Gebruikersnaam"}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get_first(
                data,
                (["Activity", "Your Activity"], ["Following List", "Following"], "Following"),
                ("Profile And Settings", "Following", "Following"),
            )
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Volgend.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Following.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            items = _parse_tiktok_txt(data.data)
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    try:
        rows = [(_item_get(item, "Date", "Datum"), _item_get(item, "UserName", "User Name", "Username", "Gebruikersnaam")) for item in items]
        out = pd.DataFrame(rows, columns=["Date", "UserName"])  # pyright: ignore
        out = out.sort_values("Date", ascending=False)
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def like_list_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok liked videos list.

    Reads ``Activity > Like List > ItemFavoriteList`` from the TikTok export JSON
    or from ``Likelijst.txt`` or ``Like List.txt`` in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during
        extraction.  Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Date``, ``Link``.
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::

        {
          "summary": "Each row represents one TikTok video the participant liked.",
          "source_file": "user_data_tiktok.json, user_data.json, Like List.txt or Likelijst.txt",
          "columns": {
            "Date": "Timestamp of when the video was liked.",
            "Link": "URL of the liked TikTok video."
          }
        }

    Table config::

        {
          "id": "tiktok_like_list",
          "title": {"en": "Videos you liked", "nl": "Video's die je leuk vond"},
          "description": {
            "en": "Videos you have liked on TikTok.",
            "nl": "Video's die je leuk hebt gevonden op TikTok."
          },
          "headers": {
            "Date": {"en": "Date", "nl": "Datum en tijd"},
            "Link": {"en": "Link", "nl": "Link"}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get_first(
                data,
                (["Activity", "Your Activity"], "Like List", "ItemFavoriteList"),
                ("Likes and Favorites", "Like List", "ItemFavoriteList"),
            )
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:  
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Likelijst.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Like List.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            items = _parse_tiktok_txt(data.data)
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    try:
        rows = [(_item_get(item, "Date", "Datum"), _item_get(item, "Link")) for item in items]
        out = pd.DataFrame(rows, columns=["Date", "Link"])  # pyright: ignore
        out = out.sort_values("Date", ascending=False)
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def searches_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok search history.

    Reads ``Activity > Search History > SearchList`` from the TikTok export JSON
    or from ``Zoekopdrachten.txt`` or ``Searches.txt`` in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during
        extraction.  Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Date``, ``SearchTerm``.
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::

        {
          "summary": "Each row represents one search the participant performed on TikTok.",
          "source_file": "user_data_tiktok.json, user_data.json, Searches.txt or Zoekopdrachten.txt",
          "columns": {
            "Date": "Timestamp of when the search was performed.",
            "SearchTerm": "The search term entered by the participant."
          }
        }

    Table config::

        {
          "id": "tiktok_searches",
          "title": {"en": "Search history", "nl": "Zoekgeschiedenis"},
          "description": {
            "en": "Search terms you have used on TikTok.",
            "nl": "Zoektermen die je hebt gebruikt op TikTok."
          },
          "headers": {
            "Date": {"en": "Date", "nl": "Datum en tijd"},
            "SearchTerm": {"en": "Search term", "nl": "Zoekterm"}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get(
                data,
                ["Activity", "Your Activity"],
                ["Search History", "Searches"],
                "SearchList",
            )
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Zoekopdrachten.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Searches.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            items = _parse_tiktok_txt(data.data)
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    try:       
        rows = [(_item_get(item, "Date","Datum"), _item_get(item, "SearchTerm", "Search Term", "Zoekterm")) for item in items]
        out = pd.DataFrame(rows, columns=["Date", "SearchTerm"])  # pyright: ignore
        out = out.sort_values("Date", ascending=False)
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def share_history_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok share history.

    Reads ``Activity > Share History > ShareHistoryList`` from the TikTok
    export JSON or from ``Geschiedenis delen.txt`` or ``Share History.txt`` 
    in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during
        extraction.  Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Date``, ``SharedContent``, ``Link``, ``Method``.
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::

        {
          "summary": "Each row represents one piece of content the participant shared on TikTok.",
          "source_file": "user_data_tiktok.json, user_data.json, Share History.txt or Geschiedenis delen.txt",
          "columns": {
            "Date": "Timestamp of when the content was shared.",
            "SharedContent": "Description of the shared content.",
            "Link": "URL of the shared content.",
            "Method": "Method used to share the content."
          }
        }

    Table config::

        {
          "id": "tiktok_share_history",
          "title": {"en": "Share history", "nl": "Deelgeschiedenis"},
          "description": {
            "en": "Content you have shared on TikTok, including when, what, and how.",
            "nl": "Inhoud die je hebt gedeeld op TikTok, inclusief wanneer, wat en hoe."
          },
          "headers": {
            "Date": {"en": "Date", "nl": "Datum en tijd"},
            "SharedContent": {"en": "Shared content", "nl": "Gedeelde inhoud"},
            "Link": {"en": "Link", "nl": "Link"},
            "Method": {"en": "Method", "nl": "Methode"}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get(
                data,
                ["Activity", "Your Activity"],
                "Share History",
                "ShareHistoryList",
            )
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Geschiedenis delen.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Share History.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            items = _parse_tiktok_txt(data.data)
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    try:
        rows = [
            (
                _item_get(item, "Date", "Datum"),
                _item_get(item, "SharedContent", "Shared Content", "Shared content", "Gedeelde content", "Gedeelde inhoud"),
                _item_get(item, "Link"),
                _item_get(item, "Method", "Methode"),
            )
            for item in items
        ]
        out = pd.DataFrame(rows, columns=["Date", "SharedContent", "Link", "Method"])  # pyright: ignore
        out = out.sort_values("Date", ascending=False)
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def comments_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok comments.

    Reads ``Comment > Comments > CommentsList`` from the TikTok export JSON or 
    from ``Reacties.txt`` or ``Comments.txt`` in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during
        extraction.  Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Date``, ``Comment``, ``Photo``, ``Url``.
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::

        {
          "summary": "Each row represents one comment the participant left on a TikTok video.",
          "source_file": "user_data_tiktok.json, user_data.json, Comments.txt or Reacties.txt",
          "columns": {
            "Date": "Timestamp of when the comment was posted.",
            "Comment": "Text of the comment.",
            "Photo": "Photo associated with the comment, if any.",
            "Url": "URL of the video the comment was posted on."
          }
        }

    Table config::

        {
          "id": "tiktok_comments",
          "title": {"en": "Your comments", "nl": "Je reacties"},
          "description": {
            "en": "Comments you have left on TikTok videos.",
            "nl": "Reacties die je hebt achtergelaten op TikTok-video's."
          },
          "headers": {
            "Date": {"en": "Date", "nl": "Datum en tijd"},
            "Comment": {"en": "Comment", "nl": "Reactie"},
            "Photo": {"en": "Photo", "nl": "Foto"},
            "Url": {"en": "Url", "nl": "Url"}
          },
          "visualizations": [
            {
              "title": {
                "en": "Most common words in your comments",
                "nl": "Meest voorkomende woorden in je reacties"
              },
              "type": "wordcloud",
              "textColumn": "Comment",
              "tokenize": true
            }
          ]
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        out = pd.DataFrame()
        try:
            items = _get(data, "Comment", "Comments", "CommentsList")
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Reacties.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Comments.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            items = _parse_tiktok_txt(data.data)
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    try:
        rows = [
            (
                _item_get(item, "Date", "Datum"),
                _item_get(item, "Comment", "Reactie"),
                _item_get(item, "Photo", "Foto"),
                _item_get(item, "Url"),
            )
            for item in items
        ]
        out = pd.DataFrame(rows, columns=["Date", "Comment", "Photo", "Url"])  # pyright: ignore
        out = out.sort_values("Date", ascending=False)
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def login_history_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok login history.

    Reads ``Activity > Login History > LoginHistoryList`` from the TikTok export JSON
    or from ``Inloggeschiedenis.txt`` or ``Login History.txt`` in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during extraction. 
        Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Date``, ``Device Model``, ``Device System``, ``Network Type``, ``Carrier``.
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::
        {
          "summary": "Each row represents one login event for the participant's TikTok account.",
          "source_file": "user_data_tiktok.json, user_data.json, Inloggeschiedenis.txt, or Login History.txt",
          "columns": {
            "Date": "Timestamp of when the login occurred.",
            "Device Model": "Model of the device used to log in.",
            "Device System": "Operating system of the device used to log in.",
            "Network Type": "Network type used during login.",
            "Carrier": "Carrier used during login."
          }
        }   

    Table config::
        {
          "id": "tiktok_login_history",
          "title": {"en": "Login history", "nl": "Inloggeschiedenis"},
          "description": {
            "en": "Login events for your TikTok account, including when, what device, and network.",
            "nl": "Inloggebeurtenissen voor je TikTok-account, inclusief wanneer, welk apparaat en netwerk."
          },
          "headers": {
            "Date": {"en": "Date", "nl": "Datum en tijd"},
            "Device Model": {"en": "Device Model", "nl": "Apparaat model"},
            "Device System": {"en": "Device System", "nl": "Apparaat Systeem"},
            "Network Type": {"en": "Network Type", "nl": "Netwerk Type"},
            "Carrier": {"en": "Carrier", "nl": "Provider"}
          }
        }
    """

    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get(
                data,
                ["Activity", "Your Activity"],
                "Login History",
                "LoginHistoryList",
            )
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Inloggeschiedenis.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Login History.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            items = _parse_tiktok_txt(data.data)
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    try:
        rows = [
            (
                _item_get(item, "Date", "Datum"),
                _item_get(item, "DeviceModel", "Device Model", "Device model", "Apparaatmodel"),
                _item_get(item, "DeviceSystem", "Device system", "Device System", "Apparaatsysteem"),
                _item_get(item, "NetworkType", "Network Type", "Netwerktype"),
                _item_get(item, "Carrier", "Provider"),
            )
            for item in items
        ]
        out = pd.DataFrame(rows, columns=["Date", "Device Model", "Device System", "Network Type", "Carrier"])  # pyright: ignore
        out = out.sort_values("Date", ascending=False)
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def favorite_items_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok favorite items.

    Reads ``TikTok Shop > TikTokFavoriteItem > TikTokFavoriteItemResult > TikTokFavoriteItemList`` 
    from the TikTok export JSON or from ``Favoriet item.txt``, ``Favorite Item.txt`` or 
    ``Favourite Item.txt`` in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during extraction.
        Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Product``, ``Shop``, ``Time``
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::
        {
          "summary": "Each row represents one item the participant marked as a favorite on TikTok.",
          "source_file": "user_data_tiktok.json, user_data.json, Favoriet item.txt, Favorite Item.txt or Favourite Item.txt",
          "columns": {
            "Product": "Name of the product marked as favorite.",
            "Shop": "Name of the shop where the product is sold.",
            "Time": "Timestamp of when the item was marked as favorite."
          }
        }

    Table config::
        {
          "id": "tiktok_favorite_items",
          "title": {"en": "Favorite items", "nl": "Favoriete items"},
          "description": {
            "en": "Items you have marked as favorites on TikTok.",
            "nl": "Items die je als favoriet hebt gemarkeerd op TikTok."
          },
          "headers": {
            "Product": {"en": "Product", "nl": "Product"},
            "Shop": {"en": "Shop", "nl": "Winkel"},
            "Time": {"en": "Time", "nl": "Tijd"}
          }
        }
    """ 
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get(
                data,
                ["TikTok Shop"],
                "TikTokFavoriteItem",
                "TikTokFavoriteItemResult",
                "TikTokFavoriteItemList",
            )
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Favoriet item.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Favorite Item.txt")
            if not data.found:
                data = reader.raw("Favourite Item.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            # This is a special case where the TXT file contains a list, but these are not separated by newlines,
            # but by a sequence of dashes, while there are empty lines between the records. Therefore we first
            # remove the empty lines and replace the dashes with empty lines.
            text = data.data.read().decode("utf-8")
            text = re.sub(r"\n\s*\n", "\n", text)  # Remove empty lines
            text = re.sub(r"-{3,}", "\n", text)
            items = _parse_tiktok_txt(text.splitlines())
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    try:
        rows = [
            (
                _item_get(item, "Product"),
                _item_get(item, "Shop", "Winkel"),
                _item_get(item, "Time", "Tijd"),
            )
            for item in items
        ]
        out = pd.DataFrame(rows, columns=["Product", "Shop", "Time"])  # pyright: ignore
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def shopping_cart_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok shopping cart items.

    Reads ``TikTok Shop > Shopping Cart List > ShoppingCart`` 
    from the TikTok export JSON or from ``Winkelwagenlijst.txt`` or ``Shopping Cart List.txt`` in case of a
    TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during extraction.
        Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.  

    Returns
    -------
    pd.DataFrame
        Columns: ``Time``, ``Product``, ``Count``, ``Shop``
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::
        {
          "summary": "Each row represents one item in the participant's TikTok shopping cart.",
          "source_file": "user_data_tiktok.json, user_data.json, Winkelwagenlijst.txt, or Shopping Cart List.txt",
          "columns": {
            "Time": "Timestamp of when the item was added to the shopping cart.",
            "Product": "Name of the product in the shopping cart.",
            "Count": "Quantity of the product in the shopping cart.",
            "Shop": "Name of the shop where the product is sold."
          }
        }

    Table config::
        {
          "id": "tiktok_shopping_cart",
          "title": {"en": "Shopping cart", "nl": "Winkelwagen"},
          "description": {
            "en": "Items you have added to your TikTok shopping cart.",
            "nl": "Items die je aan je TikTok-winkelwagen hebt toegevoegd."
          },
          "headers": {
            "Time": {"en": "Time", "nl": "Tijd"},
            "Product": {"en": "Product", "nl": "Product"},
            "Count": {"en": "Count", "nl": "Aantal"},
            "Shop": {"en": "Shop", "nl": "Winkel"}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get(
                data,
                "TikTok Shop",
                "Shopping Cart List",
                "ShoppingCart",
            )
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Winkelwagenlijst.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Shopping Cart List.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            # This is a special case where the product name and quantity keys are preceded by '>>' and the 
            # value can be on the next line. Therefore we first remove the '>>' and join the lines with a 
            # space if needed.
            text = data.data.read().decode("utf-8")
            text = re.sub(r">>\s*([a-zA-Z]+?):\s*([^\n]*?)", r"\1: ", text)
            items = _parse_tiktok_txt(text.splitlines())
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    try:
        rows = [
            (
                _item_get(item, "CreateTime", "Creation date", "Datum gemaakt"),
                _item_get(item, "ProductName", "Name", "Naam"),
                _item_get(item, "SkuCount", "Quantity", "Hoeveelheid"),
                _item_get(item, "ShopName", "Shop Name", "Naam winkel"),
            )
            for item in items
        ]
        out = pd.DataFrame(rows, columns=["Time", "Product", "Count", "Shop"])  # pyright: ignore
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def vouchers_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok vouchers.

    Reads ``TikTok Shop > Voucher List > Voucher`` from the TikTok export JSON or from 
    ``Vouchers.txt`` in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during extraction.
        Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Received Date``, ``Voucher ID``, ``VoucherName``, ``Discount Details``, ``Voucher Status``
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::
        {
          "summary": "Each row represents one voucher the participant has in their TikTok account.",
          "source_file": "user_data_tiktok.json, user_data.json, or Vouchers.txt",
          "columns": {
            "Received Date": "Date when the voucher was received.",
            "Voucher ID": "Unique identifier for the voucher.",
            "VoucherName": "Name of the voucher.",
            "Discount Details": "Details of the discount provided by the voucher.",
            "Voucher Status": "Status of the voucher (e.g. unused)."
          }
        }

    Table config::
        {
          "id": "tiktok_vouchers",
          "title": {"en": "Vouchers", "nl": "Vouchers"},
          "description": {
            "en": "Vouchers you have in your TikTok account.",
            "nl": "Vouchers die je in je TikTok-account hebt."
          },
          "headers": {
            "Received Date": {"en": "Received Date", "nl": "Datum ontvangen"},
            "Voucher ID": {"en": "Voucher ID", "nl": "Voucher ID"},
            "VoucherName": {"en": "Voucher Name", "nl": "Voucher Naam"},
            "Discount Details": {"en": "Discount Details", "nl": "Kortingsdetails"},
            "Voucher Status": {"en": "Voucher Status", "nl": "Voucher Status"}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get(
                data,
                "TikTok Shop",
                "Vouchers",
                "Vouchers",
            )
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Vouchers.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Vouchers.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            items = _parse_tiktok_txt(data.data)
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    try:
        rows = [
            (
                _item_get(item, "ReceivedDate", "Date Received", "Datum ontvangen"),
                _item_get(item, "VoucherId", "Voucher Id", "Voucher-ID"),
                _item_get(item, "VoucherName", "Voucher Name", "Vouchernaam"),
                _item_get(item, "DiscountDetails", "VoucherText", "Discount Details", "Kortingsdetails"),
                _item_get(item, "Status", "VoucherStatus", "Voucherstatus"),
            )
            for item in items
        ]
        out = pd.DataFrame(rows, columns=["Received Date", "Voucher ID", "VoucherName", "Discount Details", "Voucher Status"])  # pyright: ignore
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


def order_history_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract TikTok order history.

    Reads ``TikTok Shop > Order History > OrderHistories`` from the TikTok export JSON or 
    from ``Order History.txt`` or ``Bestelgeschiedenis.txt`` in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during extraction.
        Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.  

    Returns
    -------
    pd.DataFrame
        Columns: ``Date``, ``Products``, ``Total price``, ``Order status``
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::
        {
          "summary": "Each row represents one order by the participant on TikTok.",
          "source_file": "user_data_tiktok.json, user_data.json, Order History.txt, or Bestelgeschiedenis.txt",
          "columns": {
            "Date": "Date when the order was made.",
            "Products": "Information about the products that were bought including product name, variation and quantity.",
            "Total price": "Price for the full quantity of the product.",
            "Order status": "Status of the order."
          }
        }

    Table config::
        {
          "id": "tiktok_order_history",
          "title": {"en": "Order history", "nl": "Bestelgeschiedenis"},
          "description": {
            "en": "Your orders on TikTok.",
            "nl": "Jouw bestellingen op TikTok."
          },
          "headers": {
            "Date": {"en": "Date", "nl": "Datum en tijd"},
            "Products": {"en": "Products", "nl": "Producten"},
            "Total price": {"en": "Total price", "nl": "Totale prijs",
            "Order status": {"en": "Order status", "nl": "Bestelstatus"}}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get(
                data,
                "TikTok Shop",
                "Order History",
                "OrderHistories",
            )
            if not isinstance(items, dict):
                return out
            # JSON is dict with order numbers, convert to a list of dicts
            items = [v for k,v in items.items() if isinstance(v, dict)] 
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
            return out
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Bestelgeschiedenis.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Order History.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            # This is a special case where the products are in a list where the name and quantity fields
            # are preceded by '>>' while the value of the field named 'Variation name' in JSON is not
            # preceded by anything including the field name. Here we reshape it into a list of tuples.
            text = data.data.read().decode("utf-8") 
            p = re.compile("name (.*) is valid")
            text = re.sub(r"\n>>[A-Za-z]+:\n(.+)\n(.+)\n>>[A-Za-z]+:(.+)\n", r"(\1, \2, \3x), ", text)
            text = re.sub(r":\(", r":[(", text)
            text = re.sub(r"\), \n", r")]\n", text)
            logger.error("Exception caught: %s", text)
            items = _parse_tiktok_txt(text.splitlines())
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
            return out
    else:
        return out
    try:
        rows = []
        for item in items:
            date = _item_get(item, "order_date", "Order date", "Besteldatum")
            products = _item_get(item, "Products", "Product information", "Productinformatie")
            if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON and isinstance(products, list):
                products = [f"({product.get('product_name')}, {product.get('variation_name')}, {product.get('quantity', 0)}x)" for product in products if isinstance(product, dict)]
            price = _item_get(item, "total_price", "Total price (including shipping fee)", "Totale prijs (inclusief verzendkosten)"),
            status = _item_get(item, "order_status", "Order status", "Bestelstatus")
            rows.append((date, products, price, status))
        out = pd.DataFrame(rows, columns=["Date", "Products", "Total price", "Order status"])  # pyright: ignore
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
        return out
    return out


def product_browsing_to_df(reader: ZipArchiveReader, errors: Counter, validation) -> pd.DataFrame:
    """Extract product browsing history for TikTok shop.

    Reads ``TikTok Shop > Product Browsing History > ProductBrowsingHistories`` from the TikTok export 
    JSON or from ``Product Browsing History.txt`` or ``Geschiedenis van bladeren door producten.txt`` 
    in case of a TXT export.

    Parameters
    ----------
    reader:
        Archive reader used to load JSON or TXT files from the DDP zip.
    errors:
        Mutable counter that accumulates error type counts encountered during extraction.
        Updated in-place.
    validation:
        Validation results for the extracted data used to determine ddp type and language.

    Returns
    -------
    pd.DataFrame
        Columns: ``Browsing Date``, ``Product Name``, ``Shop Name``
        Empty DataFrame when the data is absent or parsing fails.

    Table documentation::
        {
          "summary": "Each row represents one browsing event for a product in the TikTok shop.",
          "source_file": "user_data_tiktok.json, user_data.json, Product Browsing History.txt or Geschiedenis van bladeren door producten.txt",
          "columns": {
            "Browsing Date": "Date when the product was viewed.",
            "Product Name": "Name of the viewed product.",
            "Shop Name": "Name of the shop the product belonged to."
          }
        }

    Table config::
        {
          "id": "tiktok_product_browsing",
          "title": {"en": "Product browsing history", "nl": "Bladergeschiedenis producten"},
          "description": {
            "en": "History of the products you have viewed.",
            "nl": "Geschiedenis van de producten die je hebt bekeken."
          },
          "headers": {
            "Browsing Date": {"en": "Date", "nl": "Datum en tijd"},
            "Product Name": {"en": "Product", "nl": "Product"},
            "Shop Name": {"en": "Shop", "nl": "Shop"}
          }
        }
    """
    out = pd.DataFrame()
    if validation.current_ddp_category.ddp_filetype == DDPFiletype.JSON:
        data = _load_user_data(reader)
        try:
            items = _get(
                data,
                "TikTok Shop",
                "Product Browsing History",
                "ProductBrowsingHistories"
            )
            if not isinstance(items, list):
                return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    elif validation.current_ddp_category.ddp_filetype == DDPFiletype.TXT:
        if validation.current_ddp_category.language == Language.NL:
            data = reader.raw("Geschiedenis van bladeren door producten.txt")
        elif validation.current_ddp_category.language == Language.EN:
            data = reader.raw("Product Browsing History.txt")
        else:
            return out
        if not data.found:
            return out    
        try:
            items = _parse_tiktok_txt(data.data)
            if not isinstance(items, list):
                # When only one record is present, this is not automatically recognized as a list of records.
                # Therefor the returned dict needs to be stored in a list to proceed.
                if isinstance(items, dict):
                    items = [items]
                else:
                    return out
        except Exception as e:
            logger.error("Exception caught: %s", e)
            errors[type(e).__name__] += 1
    try:
        rows = [
            (
                _item_get(item, "browsing_date", "Browsing Date", "Browsedatum"),
                _item_get(item, "shop_name", "Product Name", "Productnaam"),
                _item_get(item, "product_name", "Shop Name", "Naam winkel"),
            )
            for item in items
        ]
        out = pd.DataFrame(rows, columns=["Browsing Date", "Product Name", "Shop Name"])  # pyright: ignore
    except Exception as e:
        logger.error("Exception caught: %s", e)
        errors[type(e).__name__] += 1
    return out


# ---------------------------------------------------------------------------
# Extractor registry & platform info
# ---------------------------------------------------------------------------

#: Mapping from the string names used in port_config.json to actual extractor functions.
EXTRACTOR_REGISTRY: dict[str, Callable[..., pd.DataFrame]] = {
    "activity_summary_to_df": activity_summary_to_df,
    "settings_to_df": settings_to_df,
    "ad_link_history_to_df": ad_link_history_to_df,
    "watch_history_to_df": watch_history_to_df,
    "favorite_videos_to_df": favorite_videos_to_df,
    "following_to_df": following_to_df,
    "like_list_to_df": like_list_to_df,
    "searches_to_df": searches_to_df,
    "share_history_to_df": share_history_to_df,
    "comments_to_df": comments_to_df,
    "login_history_to_df": login_history_to_df,
    "favorite_items_to_df": favorite_items_to_df,
    "shopping_cart_to_df": shopping_cart_to_df,
    "vouchers_to_df": vouchers_to_df,
    "order_history_to_df": order_history_to_df,
    "product_browsing_to_df": product_browsing_to_df
}


# ---------------------------------------------------------------------------
# Main extraction & flow
# ---------------------------------------------------------------------------

def extraction(tiktok_zip: str, validation) -> ExtractionResult:
    """Extract data from a TikTok DDP zip and return consent-form tables.

    Parameters
    ----------
    tiktok_zip:
        Path to the TikTok DDP zip archive on disk.
    validation:
        Validation result object that is passed on to the extractor functions in 
        ``EXTRACTOR_REGISTRY``, and whose ``archive_members`` attribute is passed 
         to ``ZipArchiveReader``.
    """
    config = load_port_config(EXTRACTOR_REGISTRY, "tiktok")
    for table in config: # Pass validation results to determine ddp type and language
        table.extractor_kwargs = {'validation': validation}
    errors: Counter = Counter()
    reader = ZipArchiveReader(tiktok_zip, validation.archive_members, errors)
    return run_extraction(reader, errors, config)


class TikTokFlow(FlowBuilder):
    """Flow implementation for the TikTok data donation study."""

    def __init__(self, session_id: str):
        super().__init__(session_id, "TikTok")

    def generate_file_prompt(self):
        return ph.generate_file_prompt("application/json, application/zip")

    def validate_file(self, file):
        return validate.validate_zip(DDP_CATEGORIES, file)

    def extract_data(self, file_value, validation):
        return extraction(file_value, validation)


def process(session_id):
    flow = TikTokFlow(session_id)
    return flow.start_flow()
