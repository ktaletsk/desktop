"""Textual widgets for the notebook TUI."""

from __future__ import annotations

import re

import runtimed
from rich.markup import escape
from rich.text import Text
from textual.containers import Horizontal, Vertical
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Static, TextArea


# ANSI escape code pattern for stripping from traceback text
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _strip_ansi(text: str) -> str:
    """Remove ANSI escape codes from text."""
    return _ANSI_RE.sub("", text)


class KernelStatusBar(Static):
    """Displays kernel connection status with an indicator."""

    status: reactive[str] = reactive("disconnected")

    _STATUS_DISPLAY = {
        "disconnected": ("", "Disconnected"),
        "connecting": ("", "Connecting..."),
        "idle": ("", "Idle"),
        "busy": ("", "Busy"),
        "error": ("", "Error"),
        "starting": ("", "Starting..."),
        "shutdown": ("", "Shutdown"),
    }

    def render(self) -> str:
        icon, label = self._STATUS_DISPLAY.get(
            self.status, ("?", self.status)
        )
        return f" {icon} {label}"


class NotebookTitle(Static):
    """Displays the notebook filename."""

    pass


class OutputBlock(Static):
    """A single output block within a cell."""

    def __init__(
        self,
        output: runtimed.Output,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._output = output

    def on_mount(self) -> None:
        self._render_output()

    def _render_output(self) -> None:
        output = self._output

        if output.output_type == "stream":
            text = output.text or ""
            css_class = (
                "cell-output-error"
                if output.name == "stderr"
                else "cell-output-stream"
            )
            self.add_class(css_class)
            self.update(escape(text.rstrip("\n")))

        elif output.output_type == "execute_result":
            self.add_class("cell-output-result")
            self._render_display_data(output)

        elif output.output_type == "display_data":
            self.add_class("cell-output-result")
            self._render_display_data(output)

        elif output.output_type == "error":
            self.add_class("cell-output-error")
            ename = getattr(output, "ename", "Error") or "Error"
            evalue = getattr(output, "evalue", "") or ""
            tb_lines = getattr(output, "traceback", []) or []

            parts = []
            if tb_lines:
                for line in tb_lines:
                    parts.append(_strip_ansi(line))
            else:
                parts.append(f"{ename}: {evalue}")

            self.update(escape("\n".join(parts)))

    def _render_display_data(self, output: runtimed.Output) -> None:
        """Render display_data or execute_result output."""
        data = getattr(output, "data", None)
        if not data:
            return

        # Prefer text representations for terminal
        if "text/plain" in data:
            self.update(escape(data["text/plain"]))
        elif "text/markdown" in data:
            self.update(data["text/markdown"])
        elif "text/html" in data:
            # Strip HTML tags for terminal display
            html = data["text/html"]
            clean = re.sub(r"<[^>]+>", "", html)
            self.update(escape(clean.strip()))
        elif "image/png" in data or "image/jpeg" in data:
            self.update("[Image output - view in graphical notebook]")
        elif "application/json" in data:
            import json

            try:
                formatted = json.dumps(
                    json.loads(data["application/json"]),
                    indent=2,
                )
                self.update(escape(formatted))
            except (json.JSONDecodeError, TypeError):
                self.update(escape(str(data["application/json"])))
        else:
            # Show first available mime type
            for mime, content in data.items():
                self.update(escape(f"[{mime}]\n{str(content)[:500]}"))
                break


class CellWidget(Widget):
    """A notebook cell with gutter, source editor, and output area."""

    is_focused_cell: reactive[bool] = reactive(False)
    is_executing: reactive[bool] = reactive(False)
    execution_count: reactive[int | None] = reactive(None)
    cell_type: reactive[str] = reactive("code")

    def __init__(
        self,
        cell_id: str,
        cell_type: str = "code",
        source: str = "",
        execution_count: int | None = None,
        outputs: list[runtimed.Output] | None = None,
        **kwargs,
    ) -> None:
        super().__init__(id=f"cell-{cell_id}", classes="cell-widget --not-focused", **kwargs)
        self.cell_id = cell_id
        self.cell_type = cell_type
        self._source = source
        self.execution_count = execution_count
        self._outputs = outputs or []
        self._in_edit_mode = False

    def compose(self):
        with Horizontal():
            # Gutter: execution count and cell type indicator
            yield Static(self._gutter_text(), classes="cell-gutter")
            with Vertical(classes="cell-body"):
                # Source area
                with Vertical(classes="cell-source"):
                    yield TextArea(
                        self._source,
                        language="python" if self.cell_type == "code" else None,
                        theme="monokai",
                        id=f"source-{self.cell_id}",
                        show_line_numbers=True,
                        read_only=True,
                        tab_behavior="indent",
                        soft_wrap=True,
                    )
                # Output area
                yield Vertical(
                    *self._make_output_widgets(),
                    classes="cell-output",
                    id=f"output-{self.cell_id}",
                )

    def _gutter_text(self) -> str:
        """Build gutter text with execution count."""
        if self.cell_type == "code":
            if self.is_executing:
                return " [*]:"
            if self.execution_count is not None:
                return f"[{self.execution_count}]:"
            return "[ ]:"
        elif self.cell_type == "markdown":
            return "  MD:"
        return " RAW:"

    def _make_output_widgets(self) -> list[OutputBlock]:
        """Create output widgets from stored outputs."""
        widgets = []
        for i, output in enumerate(self._outputs):
            widgets.append(
                OutputBlock(
                    output,
                    id=f"out-{self.cell_id}-{i}",
                )
            )
        return widgets

    def _update_gutter(self) -> None:
        """Refresh the gutter display."""
        try:
            gutter = self.query_one(".cell-gutter", Static)
            gutter.update(self._gutter_text())
            if self.is_executing:
                gutter.add_class("--executing")
            else:
                gutter.remove_class("--executing")
        except Exception:
            pass

    def watch_is_focused_cell(self, focused: bool) -> None:
        if focused:
            self.remove_class("--not-focused")
            self.add_class("--focused")
        else:
            self.remove_class("--focused")
            self.add_class("--not-focused")

    def watch_is_executing(self, executing: bool) -> None:
        if executing:
            self.add_class("--executing")
        else:
            self.remove_class("--executing")
        self._update_gutter()

    def watch_execution_count(self, count: int | None) -> None:
        self._update_gutter()

    def watch_cell_type(self, cell_type: str) -> None:
        self._update_gutter()
        # Update syntax highlighting
        try:
            editor = self.query_one(f"#source-{self.cell_id}", TextArea)
            editor.language = "python" if cell_type == "code" else None
        except Exception:
            pass

    def enter_edit_mode(self) -> None:
        """Enable editing in the source TextArea."""
        self._in_edit_mode = True
        try:
            editor = self.query_one(f"#source-{self.cell_id}", TextArea)
            editor.read_only = False
            editor.focus()
        except Exception:
            pass

    def exit_edit_mode(self) -> None:
        """Disable editing in the source TextArea."""
        self._in_edit_mode = False
        try:
            editor = self.query_one(f"#source-{self.cell_id}", TextArea)
            self._source = editor.text
            editor.read_only = True
        except Exception:
            pass

    def get_source(self) -> str:
        """Get the current source text."""
        try:
            editor = self.query_one(f"#source-{self.cell_id}", TextArea)
            return editor.text
        except Exception:
            return self._source

    def set_source(self, source: str) -> None:
        """Set the source text."""
        self._source = source
        try:
            editor = self.query_one(f"#source-{self.cell_id}", TextArea)
            editor.load_text(source)
        except Exception:
            pass

    def append_output(self, output: runtimed.Output) -> None:
        """Append a new output to this cell."""
        idx = len(self._outputs)
        self._outputs.append(output)
        try:
            output_container = self.query_one(
                f"#output-{self.cell_id}", Vertical
            )
            block = OutputBlock(
                output,
                id=f"out-{self.cell_id}-{idx}",
            )
            output_container.mount(block)
        except Exception:
            pass

    def clear_outputs(self) -> None:
        """Remove all outputs from this cell."""
        self._outputs.clear()
        self.execution_count = None
        try:
            output_container = self.query_one(
                f"#output-{self.cell_id}", Vertical
            )
            output_container.remove_children()
        except Exception:
            pass
