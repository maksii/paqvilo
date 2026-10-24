# SDK verification gate: PowerPlatform-Dataverse-Client 1.1.0 + msal 1.39.0 against the Mirage Dataverse simulator over TLS.
# Run by gate.test.mjs as `python -I gate.py`. Env: SIM_TLS_ORIGIN, SIM_TENANT, SIM_CLIENT_ID, SIM_CLIENT_SECRET,
# REQUESTS_CA_BUNDLE (simulator CA). Prints one JSON object per step; exit 0 when every required step is ok.
import base64
import json
import os
import sys
import time
import uuid
import warnings

import msal
import requests
from azure.core.credentials import AccessToken, TokenCredential
from PowerPlatform.Dataverse.client import DataverseClient
from PowerPlatform.Dataverse.core.errors import HttpError

TLS = os.environ["SIM_TLS_ORIGIN"].rstrip("/")
TENANT = os.environ["SIM_TENANT"]
CLIENT_ID = os.environ["SIM_CLIENT_ID"]
SECRET = os.environ["SIM_CLIENT_SECRET"]

# requests.Session.send is patched so the trace keeps query strings, which the simulator's request log omits.
TRACE = []
_send = requests.Session.send


def _traced_send(self, request, **kwargs):
    response = _send(self, request, **kwargs)
    TRACE.append({"method": request.method, "url": request.url, "status": response.status_code})
    return response


requests.Session.send = _traced_send

app = msal.ConfidentialClientApplication(
    CLIENT_ID,
    client_credential=SECRET,
    authority=f"{TLS}/{TENANT}",
    validate_authority=False,
    instance_discovery=False,
)


class MsalCredential(TokenCredential):
    def get_token(self, *scopes, **kwargs):
        result = app.acquire_token_for_client(scopes=list(scopes))
        if "access_token" not in result:
            raise RuntimeError(f"{result.get('error')}: {result.get('error_description')}")
        return AccessToken(result["access_token"], int(time.time()) + int(result["expires_in"]))


client = DataverseClient(TLS, MsalCredential())
S = {}
REQUIRED_FAILED = []


def emit(step, ok, detail=None, optional=False):
    print(json.dumps({"step": step, "ok": ok, "optional": optional, "detail": detail}, default=str), flush=True)


def http_facts(error):
    # HttpError keeps the x-ms-service-request-id and service error code in .details.
    return {
        "status": error.status_code,
        "serviceRequestIdPresent": "service_request_id" in error.details,
        "serviceErrorCode": error.details.get("service_error_code"),
        "bodyExcerpt": error.details.get("body_excerpt"),
    }


def step(name, fn, optional=False):
    try:
        detail = fn()
    except Exception as error:  # reported per step; later steps still run
        failure = {"type": type(error).__name__, "message": str(error)}
        if isinstance(error, HttpError):
            failure.update(http_facts(error))
        emit(name, False, failure, optional)
        if not optional:
            REQUIRED_FAILED.append(name)
        return False
    emit(name, True, detail, optional)
    return True


def need(key):
    if not S.get(key):
        raise RuntimeError(f"no {key} from an earlier step")
    return S[key]


def claims(token):
    body = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))


def token_step():
    result = app.acquire_token_for_client(scopes=[f"{TLS}/.default"])
    if "access_token" not in result:
        raise RuntimeError(f"{result.get('error')}: {result.get('error_description')}")
    payload = claims(result["access_token"])
    assert payload.get("appid") == CLIENT_ID, f"appid {payload.get('appid')!r} != {CLIENT_ID!r}"
    return {"appid": payload["appid"], "aud": payload.get("aud"), "tid": payload.get("tid")}


def whoami():
    # PowerPlatform-Dataverse-Client 1.1.0 has no WhoAmI operation, so this is a raw requests call.
    result = app.acquire_token_for_client(scopes=[f"{TLS}/.default"])
    response = requests.get(
        f"{TLS}/api/data/v9.2/WhoAmI",
        headers={"Authorization": f"Bearer {result['access_token']}", "Accept": "application/json"},
        timeout=30,
    )
    response.raise_for_status()
    body = response.json()
    assert body.get("UserId") and body.get("OrganizationId"), body
    return {"raw": True, "status": response.status_code, "userId": body["UserId"],
            "serviceRequestIdPresent": "x-ms-service-request-id" in response.headers}


def create_label():
    S["id"] = client.records.create("widget", {"name": "Alpha", "price": 10, "quantity": 2, "category": "Standard"})
    uuid.UUID(S["id"])
    return {"id": S["id"]}


def create_int():
    S["id"] = client.records.create("widget", {"name": "Alpha", "price": 10, "quantity": 2, "category": 1})
    uuid.UUID(S["id"])
    return {"id": S["id"], "fallback": "category=1 after label create failed"}


def retrieve():
    record = client.records.retrieve("widget", need("id"), select=["name", "category"])
    assert record is not None, "retrieve returned None for an existing record"
    assert record.get("name") == "Alpha", record.to_dict()
    assert record.get("category") == 1, record.to_dict()
    return record.to_dict()


def update():
    client.records.update("widget", need("id"), {"name": "Beta"})
    record = client.records.retrieve("widget", S["id"], select=["name"])
    assert record.get("name") == "Beta", record.to_dict()
    return record.to_dict()


def query():
    rows = client.query.builder("widget").select("name").top(5).execute()
    assert len(rows) >= 1, f"{len(rows)} rows"
    return {"count": len(rows), "names": [row.get("name") for row in rows]}


def create_multiple():
    ids = client.records.create("widget", [{"name": "Gamma", "quantity": 1}, {"name": "Delta", "quantity": 3}])
    assert isinstance(ids, list) and len(ids) == 2, ids
    return {"ids": ids}


def batch():
    batch_request = client.batch.new()
    batch_request.records.create("widget", {"name": "Epsilon"})
    batch_request.records.update("widget", need("id"), {"quantity": 5})
    result = batch_request.execute()
    codes = [response.status_code for response in result.responses]
    assert len(codes) == 2 and all(200 <= code < 300 for code in codes), codes
    return {"statusCodes": codes, "failed": len(result.failed)}


def error_400():
    try:
        client.records.retrieve("widget", need("id"), select=["no_such_column"])
    except HttpError as error:
        assert error.status_code == 400, error.status_code
        return http_facts(error)
    raise AssertionError("no error for an unknown select column")


def delete():
    client.records.delete("widget", need("id"))
    return {"deleted": S["id"]}


def retrieve_missing():
    # The SDK documents retrieve() as returning None on 404 instead of raising.
    assert client.records.retrieve("widget", need("id")) is None, "record still present after delete"
    return {"returned": None}


def error_404():
    # records.get() is the deprecated raising variant; it surfaces the HTTP 404 as HttpError.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        try:
            client.records.get("widget", str(uuid.uuid4()))
        except HttpError as error:
            assert error.status_code == 404, error.status_code
            return http_facts(error)
    raise AssertionError("records.get did not raise for a missing record")


step("token", token_step)
step("whoami", whoami)
if not step("create", create_label):
    step("create_int_category", create_int, optional=True)
step("retrieve", retrieve)
step("update", update)
step("query", query)
step("create_multiple", create_multiple)
step("batch", batch)
step("error_400", error_400)
step("delete", delete)
step("retrieve_missing", retrieve_missing)
step("error_404", error_404)
emit("trace", True, TRACE, optional=True)

sys.exit(1 if REQUIRED_FAILED else 0)
