"""Request DTO validation — CallCreate tags and number constraints."""
import uuid

import pytest
from pydantic import ValidationError

from app.api.schemas import CallCreate


def _call(**kw):
    base = dict(agent_id=uuid.uuid4(), to_number="+14155550123")
    base.update(kw)
    return CallCreate(**base)


def test_tags_default_empty():
    assert _call().tags == {}


def test_tags_accepted():
    c = _call(tags={"region": "North", "motive": "sales"})
    assert c.tags == {"region": "North", "motive": "sales"}


def test_tags_reject_too_many():
    with pytest.raises(ValidationError, match="at most 25 tags"):
        _call(tags={f"k{i}": "v" for i in range(26)})


def test_tags_reject_long_value():
    with pytest.raises(ValidationError, match="256 characters"):
        _call(tags={"region": "x" * 257})


def test_tags_reject_long_key():
    with pytest.raises(ValidationError, match="1.64 characters"):
        _call(tags={"k" * 65: "v"})


def test_tags_reject_empty_key():
    with pytest.raises(ValidationError):
        _call(tags={"": "v"})


def test_to_number_min_length():
    with pytest.raises(ValidationError):
        _call(to_number="ab")


def test_context_and_metadata_default_empty():
    c = _call()
    assert c.context == {} and c.metadata == {}
