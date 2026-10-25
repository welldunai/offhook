"""``python -m app.demo``: run the demo voice server.

Listens on 127.0.0.1:8765 by default; Docker sets DEMO_HOST=0.0.0.0 so the
cloudflared container can reach it.
"""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.demo.server:app",
        host=os.environ.get("DEMO_HOST", "127.0.0.1"),
        port=int(os.environ.get("DEMO_PORT", "8765")),
        log_level="info",
        proxy_headers=True,
    )
