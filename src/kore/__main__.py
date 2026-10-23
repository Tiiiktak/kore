"""`python -m kore` → the same CLI as the `kore` console-script."""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
