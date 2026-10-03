---
name: Python toolchain selection
description: A package-tool mismatch can select a different Python runtime than the requested module.
---

When dependency installation was attempted after requesting Python 3.12, the package tool reported Python 3.12 installed but `uv` selected Python 3.14.6; NumPy then fell back to a source build and failed. A later project archive also had Python 3.12 configured despite requiring Python 3.13 or newer. Installing the available `python-base-3.13` module aligned the interpreter, after which the locked dependencies installed successfully.

**Why:** A mismatched interpreter can make wheel availability and dependency builds fail unexpectedly.

**How to apply:** Before syncing Python dependencies, compare `pyproject.toml` with the configured module and verify the interpreter shown by `uv`. If the project requires 3.13, use the matching Replit 3.13 module and rerun the frozen sync rather than accepting a 3.12 or 3.14 fallback.