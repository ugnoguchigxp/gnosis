#!/usr/bin/env python3
"""Backward-compatible wrapper for the e5embed CLI."""

from e5embed.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
