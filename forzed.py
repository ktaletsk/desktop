print("hey")

print("what is so slow now???")


class WellNow:
    def __init__(self):
        self.message = "Well now!"

    def __repr__(self):
        return self.message


wn = WellNow()


# %%
# Pandas DataFrame - should render as a markdown table
import pandas as pd

df = pd.DataFrame(
    {
        "Name": ["Alice", "Bob", "Charlie", "Dave", "Quill"],
        "Age": [25, 30, 35, 40, 45],
        "City": ["NYC", "LA", "Chicago", "Houston", "Seattle"],
    }
)
df


# %%

# 1. Pandas DataFrame (basic)
import pandas as pd

df = pd.DataFrame(
    {
        "Name": ["Alice", "Bob", "Charlie"],
        "Age": [25, 30, 35],
        "City": ["NYC", "LA", "Chicago"],
    }
)
df

# %%

# 2. Larger DataFrame with numbers
import numpy as np

pd.DataFrame(np.random.randn(5, 4), columns=["A", "B", "C", "D"]).round(2)

# %%

# 3. DataFrame with mixed types
pd.DataFrame(
    {
        "int": [1, 2, 3],
        "float": [1.1, 2.2, 3.3],
        "str": ["a", "b", "c"],
        "bool": [True, False, True],
    }
)

# %%

# 4. Custom HTML with headings and paragraphs
from IPython.display import HTML

HTML(
    "<h2>Section Title</h2><p>Some paragraph text with <strong>bold</strong> and <em>italic</em>.</p>"
)

# %%

# 5. HTML with lists
HTML("""
<h3>Shopping List</h3>
<ul>
  <li>Apples</li>
  <li>Bananas</li>
  <li>Oranges</li>
</ul>
<h3>Steps</h3>
<ol>
  <li>First step</li>
  <li>Second step</li>
  <li>Third step</li>
</ol>
""")

# %%

# 6. Custom HTML table
HTML("""
<table>
  <tr><th>Feature</th><th>Supported</th></tr>
  <tr><td>Tables</td><td>✓</td></tr>
  <tr><td>Headings</td><td>✓</td></tr>
  <tr><td>Lists</td><td>✓</td></tr>
  <tr><td>Bold/Italic</td><td>✓</td></tr>
</table>
""")

# %%

# 7. Code in HTML
HTML(
    "<p>Use <code>print()</code> to output text.</p><pre>def hello():\n    print('world')</pre>"
)


# %%

# 8. Polars DataFrame (if installed)
import polars as pl

pl.DataFrame({"x": [1, 2, 3], "y": ["a", "b", "c"]})

# %%

# 9. Styled DataFrame (pandas)
df = pd.DataFrame({"A": [1, 2, 3], "B": [4, 5, 6]})
df.style.highlight_max()

# %%

# 10. Series (single column)
pd.Series([1, 2, 3, 4, 5], name="values")

# %%

# 11. DataFrame with MultiIndex
arrays = [["A", "A", "B", "B"], [1, 2, 1, 2]]
index = pd.MultiIndex.from_arrays(arrays, names=["first", "second"])
pd.DataFrame({"val": [10, 20, 30, 40]}, index=index)

# %%

# 12. Wide DataFrame (many columns)
pd.DataFrame(np.random.randn(3, 16), columns=[f"c_{i}" for i in range(16)]).round(2)
