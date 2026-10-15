"""A tiny, reusable name → factory registry.

This is the single mechanism that makes the service pluggable. STT/TTS/LLM
providers, telephony backends, and agent tools are all just entries in a
``Registry``. Adding a new one never means editing a dispatch ``if/elif`` chain
somewhere central — you write a self-contained module and register it:

    from app.registry import Registry

    my_registry: Registry[MyThing] = Registry("my-thing")

    @my_registry.register("acme")
    def _build_acme(...) -> MyThing:
        ...

and selecting it is ``my_registry.get("acme")``. The registry only stores the
factory; the heavy provider import stays *inside* the factory body so optional
dependencies remain optional (importing this package never imports every SDK).

Why a class and not a bare dict? So lookups raise a helpful error that lists
what *is* registered, and so the set of registries reads as an explicit,
documented extension surface rather than scattered module-level dicts.
"""

from __future__ import annotations

from typing import Callable, Generic, TypeVar

T = TypeVar("T")


class Registry(Generic[T]):
    """Maps a string name to a value (typically a factory callable).

    ``T`` is whatever the registry holds — a factory function for providers, a
    class for telephony backends, a ``Tool`` instance for tools.
    """

    def __init__(self, kind: str) -> None:
        #: Human-readable label used only in error messages (e.g. "STT").
        self.kind = kind
        self._entries: dict[str, T] = {}

    def register(self, name: str) -> Callable[[T], T]:
        """Decorator that files the decorated object under ``name``.

        Returns the object unchanged, so it can still be imported/used directly.
        Raises if ``name`` is already taken — registration clashes are bugs, not
        silent last-wins overwrites.
        """

        def decorator(value: T) -> T:
            if name in self._entries:
                raise ValueError(f"{self.kind} provider {name!r} is already registered")
            self._entries[name] = value
            return value

        return decorator

    def get(self, name: str) -> T:
        """Look up an entry, raising a descriptive ``ValueError`` if absent."""
        try:
            return self._entries[name]
        except KeyError:
            raise ValueError(
                f"Unknown {self.kind} provider {name!r}. "
                f"Registered: {', '.join(self.names()) or '(none)'}"
            ) from None

    def names(self) -> list[str]:
        """Sorted list of registered names — handy for API discovery endpoints."""
        return sorted(self._entries)

    def __contains__(self, name: object) -> bool:
        return name in self._entries
