"""end_call: hang up only when the agent isn't waiting on an answer."""

from types import SimpleNamespace

from pipecat.frames.frames import EndFrame, LLMTextFrame, UserStartedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection

from app.tools import AgentTurnText, CallOutcome, ToolContext, tool_registry


class FakeTask:
    def __init__(self) -> None:
        self.frames: list = []

    async def queue_frame(self, frame) -> None:
        self.frames.append(frame)


async def call_end(agent_said: str):
    """Run the end_call handler as if the agent had just said `agent_said`."""
    task, outcome, results = FakeTask(), CallOutcome(), []
    ctx = ToolContext(outcome=outcome, task=task, agent_said=lambda: agent_said)
    handler = tool_registry.get("end_call")().make_handler(ctx)

    async def result_callback(result, properties=None):
        results.append((result, properties))

    await handler(SimpleNamespace(arguments={"summary": "Moved to Wednesday."}, result_callback=result_callback))
    return task, outcome, results


async def test_hangs_up_after_a_goodbye():
    task, outcome, results = await call_end("Great, you're all set for Wednesday. Bye!")
    assert isinstance(task.frames[-1], EndFrame)
    assert outcome.ended_by_agent and outcome.summary == "Moved to Wednesday."
    assert results[0][0] == {"acknowledged": True}


async def test_refuses_to_hang_up_on_an_unanswered_question():
    task, outcome, results = await call_end("You're all set. Anything else I can help with?  ")
    assert task.frames == []
    assert not outcome.ended_by_agent
    result, properties = results[0]
    assert result["ended"] is False
    assert properties.run_llm is False  # don't talk again; wait for the answer


async def test_turn_text_resets_when_the_person_talks():
    tracker = AgentTurnText()
    pushed = []

    async def push(frame, direction=FrameDirection.DOWNSTREAM):
        pushed.append(frame)

    tracker.push_frame = push  # type: ignore[method-assign]
    tracker._FrameProcessor__check_started = lambda frame: True  # type: ignore[attr-defined]
    for f in (LLMTextFrame(text="Anything "), LLMTextFrame(text="else?")):
        await tracker.process_frame(f, FrameDirection.DOWNSTREAM)
    assert tracker.text == "Anything else?"
    await tracker.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    assert tracker.text == ""
    assert len(pushed) == 3  # every frame is passed on


async def record(agent_said: str):
    """Run record_result as if the agent had just said `agent_said`."""
    outcome, results = CallOutcome(), []
    ctx = ToolContext(outcome=outcome, task=FakeTask(), agent_said=lambda: agent_said)
    handler = tool_registry.get("record_result")().make_handler(ctx)

    async def result_callback(result, properties=None):
        results.append(properties)

    await handler(SimpleNamespace(arguments={"key": "new_time", "value": "Wednesday 2:30 PM"}, result_callback=result_callback))
    return outcome, results[0]


async def test_record_after_speaking_doesnt_make_the_agent_talk_again():
    outcome, props = await record("Sure, Wednesday at 2:30 works.")
    assert outcome.data == {"new_time": "Wednesday 2:30 PM"}
    assert props.run_llm is False


async def test_record_before_speaking_lets_the_agent_reply():
    _, props = await record("")
    assert props.run_llm is True


async def test_placeholders_are_not_recorded():
    outcome, results = CallOutcome(), []
    ctx = ToolContext(outcome=outcome, task=FakeTask())
    handler = tool_registry.get("record_result")().make_handler(ctx)

    async def result_callback(result, properties=None):
        results.append(result)

    for value in ("?", "", None):
        await handler(SimpleNamespace(arguments={"key": "notice_period", "value": value}, result_callback=result_callback))
    assert outcome.data == {} and len(results) == 3
