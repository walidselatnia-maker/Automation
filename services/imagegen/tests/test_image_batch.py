"""Images over the transport Flow actually uses.

REST images started answering

    {'code': 401, 'message': 'Request had invalid authentication credentials.
     Expected OAuth 2 access token, login cookie or other valid authentication
     credential.', 'status': 'UNAUTHENTICATED'}

That is the bearer token being refused rather than the request: Flow moved to
a batchexecute endpoint on flow.google.com in September 2026, the page stopped
talking to aisandbox-pa, and the token sniffed off it stopped being good there.
The batch path signs itself inside the Flow tab and needs no sniffed token at
all.

The envelope builder and readers are Flow Kit's flow_batch.py, vendored
unchanged and not tested here -- it is their code and their captures. What
these pin is the seam this service owns: that an image goes out as a batch RPC
asking for the image captcha, and -- the part that matters most -- that the
answer comes back in the REST shape the worker already reads, so nothing
downstream had to learn a second one.
"""
import asyncio
import json

from agent.services import flow_batch as fb
from agent.services.flow_client import FlowClient
from agent.worker._parsing import extract_output_url, is_error


def client_with(reply):
    """A client whose transport returns `reply` and records what was sent."""
    client = FlowClient()
    sent: dict = {}

    async def fake_send(method, params, timeout=300):
        # Its own key: the REST params carry a "method": "POST" of their own,
        # which would otherwise overwrite the transport method being recorded.
        sent["ws_method"] = method
        sent.update(params)
        return reply

    client._send = fake_send
    return client, sent


def envelope(rpcid: str, inner) -> str:
    """A reply shaped like batchexecute's, for the reader to unwrap."""
    payload = json.dumps(inner, separators=(",", ":"))
    return ")]}'\n\n" + json.dumps([["wrb.fr", rpcid, payload, None, None, None, "generic"]])


IMAGE_URL = f"https://{fb.MEDIA_HOST}/image/abc123def?sig=xyz"


def image_reply():
    # Where the url sits inside the payload is Flow's business; read_images
    # walks every string, so any nesting that contains it is enough here.
    return {"status": 200, "data": envelope(
        fb.RPC_GEN_IMAGE, [None, [[None, None, [[IMAGE_URL]]]]]
    )}


def test_an_image_goes_out_as_a_batch_rpc_not_a_rest_call():
    client, sent = client_with(image_reply())

    asyncio.run(client.generate_images_batch("soup", "PROJ-1"))

    assert sent["ws_method"] == "batch_rpc"
    assert sent["rpcid"] == fb.RPC_GEN_IMAGE
    # No URL at all: nothing here talks to aisandbox-pa any more, so there is
    # no bearer token to be refused.
    assert "url" not in sent


def test_the_image_submit_asks_for_the_image_captcha():
    client, sent = client_with(image_reply())

    asyncio.run(client.generate_images_batch("soup", "PROJ-1"))

    assert sent["captchaAction"] == fb.CAPTCHA_IMAGE


def test_the_answer_is_in_the_shape_the_worker_already_reads():
    """The whole point of folding the batch reply into the REST shape.

    _run calls extract_output_url() on whatever comes back and has done so
    since before the batch path existed. If this stops holding, images complete
    with no url and the platform gets nothing, and the failure looks like Flow
    returning empty rather than like this adapter drifting.
    """
    client, _ = client_with(image_reply())

    result = asyncio.run(client.generate_images_batch("soup", "PROJ-1"))

    assert not is_error(result)
    assert extract_output_url(result) == IMAGE_URL
    assert result["data"]["media"][0]["name"] == "abc123def"


def test_a_transport_error_is_passed_through_as_one():
    client, _ = client_with({"error": "Extension not connected"})

    result = asyncio.run(client.generate_images_batch("soup", "PROJ-1"))

    assert is_error(result)
    assert "not connected" in result["error"]


def test_an_answer_with_no_image_in_it_is_an_error_not_a_blank_success():
    client, _ = client_with({"status": 200, "data": envelope(fb.RPC_GEN_IMAGE, [None, []])})

    result = asyncio.run(client.generate_images_batch("soup", "PROJ-1"))

    assert is_error(result)
    assert "No image url" in result["error"]


def test_the_rest_path_is_still_there_behind_the_flag():
    """IMAGE_USE_BATCH=0 has to mean something on the day Google turns REST back on."""
    client, sent = client_with({"status": 200, "data": {"media": []}})

    asyncio.run(client.generate_images("soup", "PROJ-1"))

    assert sent["ws_method"] == "api_request"
    assert "aisandbox-pa.googleapis.com" in sent["url"]
