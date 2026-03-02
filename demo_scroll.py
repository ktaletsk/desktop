# %%
# Short output — no scroll containment
print("Hello from the REPL!")

# %%
# Longer output that should trigger scroll containment
for i in range(60):
    print(f"Line {i:03d}: {'=' * 40} the quick brown fox jumps over the lazy dog")

# %%
# Mixed outputs: markdown + terminal
from IPython.display import Markdown, display

display(
    Markdown(
        "## Results Summary\n\nThe table below was generated from a **Monte Carlo** simulation."
    )
)
print("stdout: this is plain terminal output after markdown")


# %%
# Error traceback — scroll containment on the traceback
def deeply_nested(depth=20):
    if depth <= 0:
        raise ValueError("something went wrong deep in the stack")
    return deeply_nested(depth - 1)


deeply_nested()

# %%
# Streaming output — auto-scrolls to bottom
import time

for i in range(50):
    print(f"[{i:03d}] streaming log output... timestamp={time.time():.2f}")
    time.sleep(0.05)

# %%
# Wide output — tests responsive column wrapping
print("A" * 200)
print("B" * 300)
print("-" * 150)
