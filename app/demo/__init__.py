"""The live demo's voice server (DEMO.md).

A slim entrypoint that runs Offhook's real call pipeline for visitors to
offhook.welldun.ai, talking over a browser WebSocket instead of a phone line.
It has no database and no tenant API: the demo Worker (``demo/worker``) owns
sessions and limits, and this server only runs the calls it is handed.
"""
