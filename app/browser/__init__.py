"""Calls in the browser: an agent talking to someone over a WebSocket instead of a
phone line. Used by the website's live demo (``app.demo``) and by the dashboard's
"talk to your agent" test calls (``app.api.test_calls``).

  * ``serializer`` — the wire format (raw 16 kHz PCM both ways, JSON events out).
  * ``call`` — one call: Offhook's pipeline plus time and silence limits, live
    transcript and result events, response times and a results summary.
"""
