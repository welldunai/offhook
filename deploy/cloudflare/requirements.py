"""Print the cloud image's requirements: pyproject's dependencies, minus WebRTC.

The hosted app never mounts the WebRTC dev playground (ENABLE_PREBUILT_UI is
false in prod), so Pipecat's webrtc/runner extras and the playground package are
left out. Usage: python requirements.py pyproject.toml > requirements.txt
"""

import re
import sys
import tomllib

DROP_EXTRAS = {"webrtc", "runner"}
DROP_PACKAGES = {"pipecat-ai-small-webrtc-prebuilt"}

deps = tomllib.load(open(sys.argv[1], "rb"))["project"]["dependencies"]
for dep in deps:
    name = re.split(r"[\[<>=!~ ;]", dep, maxsplit=1)[0].lower()
    if name in DROP_PACKAGES:
        continue
    m = re.match(r"^([A-Za-z0-9_.-]+)\[([^\]]+)\](.*)$", dep)
    if m:
        extras = [e.strip() for e in m.group(2).split(",") if e.strip() not in DROP_EXTRAS]
        dep = f"{m.group(1)}[{','.join(extras)}]{m.group(3)}" if extras else f"{m.group(1)}{m.group(3)}"
    print(dep)
