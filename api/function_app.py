import json
import os
import random
import string
import uuid

import azure.functions as func
from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
from azure.data.tables import TableServiceClient

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

# ── Storage helpers ───────────────────────────────────────────────────────────
#
# Key scheme — PartitionKey is the room code (4 uppercase letters, no special
# chars). RowKey encodes entity type:
#   meta              → room metadata
#   p-{playerId}      → one per player
#   a-{qIdx}-{pid}    → one per player per question (answer)
#
# The '#' character is forbidden in Table Storage keys, so we use '-' instead.
#
TABLE_NAME = "redditornot"

def get_table_client():
    conn = os.environ["AzureWebJobsStorage"]
    svc  = TableServiceClient.from_connection_string(conn)
    svc.create_table_if_not_exists(TABLE_NAME)
    return svc.get_table_client(TABLE_NAME)

def room_entities(client, room_code: str) -> list:
    return list(client.query_entities(f"PartitionKey eq '{room_code}'"))

def load_questions() -> list:
    path = os.path.join(os.path.dirname(__file__), "data", "questions.json")
    with open(path) as f:
        return json.load(f)

def json_ok(data) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(data), mimetype="application/json")

def err(msg: str, status: int) -> func.HttpResponse:
    return func.HttpResponse(msg, status_code=status)

# ── POST /api/create-room ─────────────────────────────────────────────────────
@app.route(route="create-room", methods=["POST"])
def create_room(req: func.HttpRequest) -> func.HttpResponse:
    body = req.get_json()
    name = body.get("name", "").strip()
    if not name:
        return err("name required", 400)

    questions    = load_questions()
    selected_ids = [q["id"] for q in random.sample(questions, min(10, len(questions)))]

    room_code = "".join(random.choices(string.ascii_uppercase, k=4))
    host_id   = str(uuid.uuid4())

    client = get_table_client()

    client.upsert_entity({
        "PartitionKey":    room_code,
        "RowKey":          "meta",
        "phase":           "lobby",
        "currentQuestion": 0,
        "questionIds":     json.dumps(selected_ids),
        "hostId":          host_id,
    })

    client.upsert_entity({
        "PartitionKey": room_code,
        "RowKey":       f"p-{host_id}",
        "name":         name,
        "totalScore":   0,
    })

    return json_ok({"roomCode": room_code, "playerId": host_id, "isHost": True})

# ── POST /api/join-room ───────────────────────────────────────────────────────
@app.route(route="join-room", methods=["POST"])
def join_room(req: func.HttpRequest) -> func.HttpResponse:
    body      = req.get_json()
    room_code = body.get("roomCode", "").strip().upper()
    name      = body.get("name", "").strip()

    if not room_code or not name:
        return err("roomCode and name required", 400)

    client = get_table_client()

    try:
        meta = client.get_entity(room_code, "meta")
    except ResourceNotFoundError:
        return err("Room not found", 404)

    if meta["phase"] != "lobby":
        return err("Game already started", 409)

    player_id = str(uuid.uuid4())
    client.upsert_entity({
        "PartitionKey": room_code,
        "RowKey":       f"p-{player_id}",
        "name":         name,
        "totalScore":   0,
    })

    return json_ok({"roomCode": room_code, "playerId": player_id, "isHost": False})

# ── GET /api/get-state ────────────────────────────────────────────────────────
#
# One Table Storage query fetches all rows for the room. We filter and reshape
# in Python rather than making separate queries.
#
# redditScore is stripped from options in question phase so players can't cheat
# by reading the network response before picking an answer.
#
@app.route(route="get-state", methods=["GET"])
def get_state(req: func.HttpRequest) -> func.HttpResponse:
    room_code = req.params.get("roomCode", "").upper()
    player_id = req.params.get("playerId", "")

    if not room_code or not player_id:
        return err("roomCode and playerId required", 400)

    client   = get_table_client()
    entities = room_entities(client, room_code)

    if not entities:
        return err("Room not found", 404)

    meta = next((e for e in entities if e["RowKey"] == "meta"), None)
    if not meta:
        return err("Room not found", 404)

    phase        = meta["phase"]
    current_q    = meta["currentQuestion"]
    question_ids = json.loads(meta["questionIds"])

    players = [
        {
            "playerId":   e["RowKey"].removeprefix("p-"),
            "name":       e["name"],
            "totalScore": e["totalScore"],
        }
        for e in entities if e["RowKey"].startswith("p-")
    ]

    answer_key    = f"a-{current_q}-{player_id}"
    has_answered  = any(e["RowKey"] == answer_key for e in entities)
    answer_count  = sum(1 for e in entities if e["RowKey"].startswith(f"a-{current_q}-"))

    response = {
        "phase":         phase,
        "players":       [{"name": p["name"], "totalScore": p["totalScore"]} for p in players],
        "currentQ":      current_q,
        "totalQ":        len(question_ids),
        "hasAnswered":   has_answered,
        "answeredCount": answer_count,
        "totalPlayers":  len(players),
    }

    if phase in ("question", "reveal"):
        q_map    = {q["id"]: q for q in load_questions()}
        question = q_map.get(question_ids[current_q])
        if question:
            response["question"] = {
                "text":    question["text"],
                "options": [{"text": o["text"]} for o in question["options"]],
            }

    if phase == "reveal":
        q_map    = {q["id"]: q for q in load_questions()}
        question = q_map.get(question_ids[current_q])
        p_map    = {p["playerId"]: p["name"] for p in players}

        answer_entities = [e for e in entities if e["RowKey"].startswith(f"a-{current_q}-")]
        response["answers"] = [
            {
                "playerName":  p_map.get(e["playerId"], "Unknown"),
                "answerIndex": e["answerIndex"],
                "answerText":  question["options"][e["answerIndex"]]["text"],
                "redditScore": e["redditScore"],
            }
            for e in answer_entities
        ]

    return json_ok(response)

# ── POST /api/submit-answer ───────────────────────────────────────────────────
#
# create_entity (not upsert_entity) is intentional: it fails with
# ResourceExistsError if the player already answered, which we catch and ignore.
# This prevents both double-submission and answer changes after the fact.
#
@app.route(route="submit-answer", methods=["POST"])
def submit_answer(req: func.HttpRequest) -> func.HttpResponse:
    body           = req.get_json()
    room_code      = body.get("roomCode", "").upper()
    player_id      = body.get("playerId", "")
    question_index = body.get("questionIndex")
    answer_index   = body.get("answerIndex")

    if not room_code or not player_id or question_index is None or answer_index is None:
        return err("roomCode, playerId, questionIndex and answerIndex required", 400)

    client = get_table_client()

    try:
        meta = client.get_entity(room_code, "meta")
    except ResourceNotFoundError:
        return err("Room not found", 404)

    if meta["phase"] != "question":
        return err("Not in question phase", 409)

    if meta["currentQuestion"] != question_index:
        return err("Question index mismatch", 409)

    question_ids = json.loads(meta["questionIds"])
    q_map        = {q["id"]: q for q in load_questions()}
    question     = q_map[question_ids[question_index]]
    reddit_score = question["options"][answer_index]["redditScore"]

    try:
        client.create_entity({
            "PartitionKey": room_code,
            "RowKey":       f"a-{question_index}-{player_id}",
            "playerId":     player_id,
            "answerIndex":  answer_index,
            "redditScore":  reddit_score,
        })
    except ResourceExistsError:
        pass

    return json_ok({"ok": True})

# ── POST /api/advance-phase ───────────────────────────────────────────────────
#
# Host-only state machine driver:
#   lobby    → question   (Start Game)
#   question → reveal     (Reveal Answers — tallies scores first)
#   reveal   → question   (Next Question)
#   reveal   → final      (Next Question on last question)
#
@app.route(route="advance-phase", methods=["POST"])
def advance_phase(req: func.HttpRequest) -> func.HttpResponse:
    body      = req.get_json()
    room_code = body.get("roomCode", "").upper()
    player_id = body.get("playerId", "")

    if not room_code or not player_id:
        return err("roomCode and playerId required", 400)

    client = get_table_client()

    try:
        meta = client.get_entity(room_code, "meta")
    except ResourceNotFoundError:
        return err("Room not found", 404)

    if meta["hostId"] != player_id:
        return err("Only the host can advance the phase", 403)

    phase     = meta["phase"]
    current_q = meta["currentQuestion"]
    total_q   = len(json.loads(meta["questionIds"]))

    if phase == "lobby":
        meta["phase"] = "question"
        client.update_entity(meta)

    elif phase == "question":
        entities        = room_entities(client, room_code)
        answer_entities = [e for e in entities if e["RowKey"].startswith(f"a-{current_q}-")]

        for answer in answer_entities:
            player_entity = client.get_entity(room_code, f"p-{answer['playerId']}")
            player_entity["totalScore"] += answer["redditScore"]
            client.update_entity(player_entity)

        meta["phase"] = "reveal"
        client.update_entity(meta)

    elif phase == "reveal":
        is_last = current_q >= total_q - 1
        if is_last:
            meta["phase"] = "final"
        else:
            meta["currentQuestion"] = current_q + 1
            meta["phase"]           = "question"
        client.update_entity(meta)

    return json_ok({"ok": True})
