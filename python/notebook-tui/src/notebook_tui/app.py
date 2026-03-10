"""Main Textual application for the notebook TUI."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from threading import Event as ThreadEvent

import runtimed
from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.css.query import NoMatches
from textual.reactive import reactive
from textual.screen import ModalScreen
from textual.widgets import (
    Footer,
    Header,
    Input,
    Label,
    Static,
    TextArea,
)

from notebook_tui.widgets import (
    CellWidget,
    KernelStatusBar,
    NotebookTitle,
)


class OpenNotebookScreen(ModalScreen[str | None]):
    """Modal screen to enter a notebook path."""

    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical(id="open-dialog"):
            yield Label("Open Notebook", id="dialog-title")
            yield Input(
                placeholder="Path to .ipynb file (or leave empty for new notebook)",
                id="notebook-path-input",
            )

    def on_mount(self) -> None:
        self.query_one("#notebook-path-input", Input).focus()

    @on(Input.Submitted, "#notebook-path-input")
    def on_submit(self, event: Input.Submitted) -> None:
        self.dismiss(event.value.strip() or None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ChangeCellTypeScreen(ModalScreen[str | None]):
    """Modal to change cell type."""

    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical(id="cell-type-dialog"):
            yield Label("Change Cell Type", id="dialog-title")
            yield Static("[bold]c[/] Code  |  [bold]m[/] Markdown  |  [bold]r[/] Raw")

    def key_c(self) -> None:
        self.dismiss("code")

    def key_m(self) -> None:
        self.dismiss("markdown")

    def key_r(self) -> None:
        self.dismiss("raw")

    def action_cancel(self) -> None:
        self.dismiss(None)


class NotebookApp(App):
    """A rich notebook TUI powered by runtimed and Textual."""

    TITLE = "notebook-tui"
    SUB_TITLE = "runtimed"

    CSS = """
    Screen {
        background: $surface;
    }

    #notebook-container {
        height: 1fr;
        padding: 0 1;
    }

    #status-bar {
        dock: bottom;
        height: 1;
        background: $primary-background;
        color: $text;
        padding: 0 1;
    }

    #kernel-status {
        width: auto;
        min-width: 20;
        color: $text-muted;
    }

    #notebook-title {
        width: 1fr;
        text-align: center;
        color: $text;
    }

    #cell-count {
        width: auto;
        min-width: 10;
        text-align: right;
        color: $text-muted;
    }

    .cell-widget {
        margin: 0 0 1 0;
        height: auto;
        max-height: 100%;
    }

    .cell-widget.--focused {
        border: heavy $accent;
    }

    .cell-widget.--not-focused {
        border: tall $surface-lighten-2;
    }

    .cell-widget.--executing {
        border: heavy $warning;
    }

    .cell-gutter {
        width: 6;
        height: auto;
        min-height: 3;
        padding: 0;
        color: $text-muted;
        text-align: right;
    }

    .cell-gutter.--executing {
        color: $warning;
    }

    .cell-body {
        width: 1fr;
        height: auto;
    }

    .cell-source {
        height: auto;
        min-height: 3;
        max-height: 30;
    }

    .cell-source TextArea {
        height: auto;
        min-height: 3;
        max-height: 30;
    }

    .cell-output {
        height: auto;
        max-height: 40;
        padding: 0 0 0 1;
        margin: 0;
    }

    .cell-output-stream {
        height: auto;
        color: $text;
    }

    .cell-output-error {
        height: auto;
        color: $error;
    }

    .cell-output-result {
        height: auto;
        color: $success;
    }

    .cell-type-badge {
        width: 4;
        height: 1;
        padding: 0;
        text-align: center;
        text-style: bold;
    }

    .cell-type-badge.--code {
        color: $accent;
    }

    .cell-type-badge.--markdown {
        color: $success;
    }

    .cell-type-badge.--raw {
        color: $text-muted;
    }

    .empty-notebook {
        text-align: center;
        padding: 4;
        color: $text-muted;
    }

    #open-dialog, #cell-type-dialog {
        align: center middle;
        width: 60;
        height: auto;
        max-height: 10;
        border: thick $accent;
        background: $surface;
        padding: 1 2;
    }

    #dialog-title {
        text-align: center;
        text-style: bold;
        margin-bottom: 1;
    }

    #notebook-path-input {
        width: 100%;
    }
    """

    BINDINGS = [
        Binding("ctrl+q", "quit", "Quit", priority=True),
        Binding("ctrl+s", "save", "Save"),
        Binding("ctrl+o", "open_notebook", "Open"),
        Binding("ctrl+n", "new_notebook", "New"),
        Binding("a", "add_cell_above", "Add Above", show=False),
        Binding("b", "add_cell_below", "Add Below", show=False),
        Binding("d,d", "delete_cell", "Delete Cell", show=False),
        Binding("shift+enter", "execute_cell", "Run Cell", priority=True),
        Binding("ctrl+enter", "execute_and_next", "Run & Next", priority=True),
        Binding("ctrl+shift+enter", "run_all", "Run All"),
        Binding("j", "focus_next_cell", "Next Cell", show=False),
        Binding("k", "focus_prev_cell", "Prev Cell", show=False),
        Binding("down", "focus_next_cell", "Next Cell", show=False),
        Binding("up", "focus_prev_cell", "Prev Cell", show=False),
        Binding("enter", "enter_edit", "Edit Cell", show=False),
        Binding("escape", "exit_edit", "Command Mode", priority=True),
        Binding("ctrl+c", "interrupt_kernel", "Interrupt"),
        Binding("t", "change_cell_type", "Cell Type", show=False),
        Binding("ctrl+shift+h", "toggle_help", "Help"),
    ]

    kernel_status: reactive[str] = reactive("disconnected")
    focused_cell_index: reactive[int] = reactive(0)
    edit_mode: reactive[bool] = reactive(False)
    notebook_path: reactive[str | None] = reactive(None)

    def __init__(
        self,
        notebook_path: str | None = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._notebook_path_arg = notebook_path
        self._session: runtimed.Session | None = None
        self._cell_ids: list[str] = []
        self._executing_cells: set[str] = set()
        self._kernel_ready = ThreadEvent()

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="status-bar"):
            yield KernelStatusBar(id="kernel-status")
            yield NotebookTitle(id="notebook-title")
            yield Static("0 cells", id="cell-count")
        yield VerticalScroll(id="notebook-container")
        yield Footer()

    def on_mount(self) -> None:
        if self._notebook_path_arg:
            self._open_notebook(self._notebook_path_arg)
        else:
            self._create_new_notebook()

    @work(thread=True, group="session")
    def _open_notebook(self, path: str) -> None:
        """Open an existing notebook file."""
        try:
            self._session = runtimed.Session.open_notebook(path)
            self.notebook_path = path
            self._post_connect()
        except runtimed.RuntimedError as e:
            self.notify(f"Error opening notebook: {e}", severity="error")

    @work(thread=True, group="session")
    def _create_new_notebook(self) -> None:
        """Create a new empty notebook."""
        try:
            self._session = runtimed.Session.create_notebook(runtime="python")
            self.notebook_path = None
            self._post_connect()
        except runtimed.RuntimedError as e:
            self.notify(f"Error creating notebook: {e}", severity="error")

    def _post_connect(self) -> None:
        """After connecting, load cells and start kernel."""
        session = self._session
        if session is None:
            return

        self.kernel_status = "connecting"
        self.call_from_thread(self._update_kernel_status, "connecting")

        # Load existing cells
        try:
            cells = session.get_cells()
            self.call_from_thread(self._load_cells, cells)
        except runtimed.RuntimedError:
            pass

        # Start kernel
        try:
            session.start_kernel()
            self.kernel_status = "idle"
            self.call_from_thread(self._update_kernel_status, "idle")
            self._kernel_ready.set()
        except runtimed.RuntimedError as e:
            self.call_from_thread(self._update_kernel_status, "error")
            self.call_from_thread(
                self.notify, f"Kernel start failed: {e}", severity="error"
            )

        # Start listening for broadcasts
        self._listen_for_broadcasts()

    def _listen_for_broadcasts(self) -> None:
        """Listen for daemon broadcasts in background thread."""
        session = self._session
        if session is None:
            return

        try:
            for event in session.subscribe():
                self._handle_broadcast(event)
        except runtimed.RuntimedError:
            self.call_from_thread(self._update_kernel_status, "disconnected")

    def _handle_broadcast(self, event: runtimed.ExecutionEvent) -> None:
        """Process a broadcast event from the daemon."""
        if event.event_type == "execution_started":
            cell_id = event.cell_id
            self._executing_cells.add(cell_id)
            self.call_from_thread(self._mark_cell_executing, cell_id, True)
            self.call_from_thread(self._update_kernel_status, "busy")

        elif event.event_type == "output":
            cell_id = event.cell_id
            output = event.output
            self.call_from_thread(self._append_output, cell_id, output)

        elif event.event_type == "done":
            cell_id = event.cell_id
            self._executing_cells.discard(cell_id)
            self.call_from_thread(self._mark_cell_executing, cell_id, False)
            # Refresh execution count
            if self._session:
                try:
                    cell = self._session.get_cell(cell_id)
                    self.call_from_thread(
                        self._update_execution_count,
                        cell_id,
                        cell.execution_count,
                    )
                except runtimed.RuntimedError:
                    pass
            if not self._executing_cells:
                self.call_from_thread(self._update_kernel_status, "idle")

        elif event.event_type == "error":
            cell_id = event.cell_id
            if cell_id:
                self._executing_cells.discard(cell_id)
                self.call_from_thread(self._mark_cell_executing, cell_id, False)
            self.call_from_thread(self._update_kernel_status, "idle")

    def _load_cells(self, cells: list[runtimed.Cell]) -> None:
        """Load cells into the UI."""
        container = self.query_one("#notebook-container", VerticalScroll)
        container.remove_children()
        self._cell_ids.clear()

        if not cells:
            self._add_empty_placeholder()
            return

        for cell in cells:
            self._cell_ids.append(cell.id)
            widget = CellWidget(
                cell_id=cell.id,
                cell_type=cell.cell_type,
                source=cell.source,
                execution_count=cell.execution_count,
                outputs=cell.outputs or [],
            )
            container.mount(widget)

        self._update_cell_count()
        if self._cell_ids:
            self.focused_cell_index = 0
            self._focus_cell(0)

    def _add_empty_placeholder(self) -> None:
        """Show placeholder when notebook is empty."""
        container = self.query_one("#notebook-container", VerticalScroll)
        container.mount(
            Static(
                "[bold]Empty Notebook[/]\n\n"
                "Press [bold]b[/] to add a cell\n"
                "Press [bold]Ctrl+O[/] to open a notebook",
                classes="empty-notebook",
            )
        )

    def _update_kernel_status(self, status: str) -> None:
        """Update kernel status display."""
        self.kernel_status = status
        try:
            bar = self.query_one("#kernel-status", KernelStatusBar)
            bar.status = status
        except NoMatches:
            pass

    def _update_cell_count(self) -> None:
        """Update cell count display."""
        count = len(self._cell_ids)
        try:
            label = self.query_one("#cell-count", Static)
            label.update(f"{count} cell{'s' if count != 1 else ''}")
        except NoMatches:
            pass

    def watch_notebook_path(self, path: str | None) -> None:
        """Update title when notebook path changes."""
        try:
            title = self.query_one("#notebook-title", NotebookTitle)
            if path:
                title.update(Path(path).name)
            else:
                title.update("Untitled Notebook")
        except NoMatches:
            pass

    # --- Cell focus management ---

    def _focus_cell(self, index: int) -> None:
        """Focus a cell by index."""
        if not self._cell_ids:
            return
        index = max(0, min(index, len(self._cell_ids) - 1))
        self.focused_cell_index = index

        # Update visual focus
        for i, cell_id in enumerate(self._cell_ids):
            try:
                widget = self.query_one(f"#cell-{cell_id}", CellWidget)
                widget.is_focused_cell = i == index
            except NoMatches:
                pass

        # Scroll into view
        try:
            cell_id = self._cell_ids[index]
            widget = self.query_one(f"#cell-{cell_id}", CellWidget)
            widget.scroll_visible()
        except (NoMatches, IndexError):
            pass

    def _get_focused_cell_widget(self) -> CellWidget | None:
        """Get the currently focused cell widget."""
        if not self._cell_ids or self.focused_cell_index >= len(self._cell_ids):
            return None
        cell_id = self._cell_ids[self.focused_cell_index]
        try:
            return self.query_one(f"#cell-{cell_id}", CellWidget)
        except NoMatches:
            return None

    def _mark_cell_executing(self, cell_id: str, executing: bool) -> None:
        """Mark a cell as executing or not."""
        try:
            widget = self.query_one(f"#cell-{cell_id}", CellWidget)
            widget.is_executing = executing
        except NoMatches:
            pass

    def _append_output(self, cell_id: str, output: runtimed.Output) -> None:
        """Append an output to a cell."""
        try:
            widget = self.query_one(f"#cell-{cell_id}", CellWidget)
            widget.append_output(output)
        except NoMatches:
            pass

    def _update_execution_count(
        self, cell_id: str, count: int | None
    ) -> None:
        """Update a cell's execution count."""
        try:
            widget = self.query_one(f"#cell-{cell_id}", CellWidget)
            widget.execution_count = count
        except NoMatches:
            pass

    # --- Actions ---

    def action_focus_next_cell(self) -> None:
        if self.edit_mode:
            return
        self._focus_cell(self.focused_cell_index + 1)

    def action_focus_prev_cell(self) -> None:
        if self.edit_mode:
            return
        self._focus_cell(self.focused_cell_index - 1)

    def action_enter_edit(self) -> None:
        """Enter edit mode on the focused cell."""
        widget = self._get_focused_cell_widget()
        if widget:
            self.edit_mode = True
            widget.enter_edit_mode()

    def action_exit_edit(self) -> None:
        """Exit edit mode, sync source back to session."""
        if not self.edit_mode:
            return
        self.edit_mode = False
        widget = self._get_focused_cell_widget()
        if widget:
            widget.exit_edit_mode()
            self._sync_cell_source(widget.cell_id, widget.get_source())

    @work(thread=True)
    def _sync_cell_source(self, cell_id: str, source: str) -> None:
        """Sync cell source to daemon."""
        if self._session:
            try:
                self._session.set_source(cell_id, source)
            except runtimed.RuntimedError as e:
                self.call_from_thread(
                    self.notify, f"Sync error: {e}", severity="warning"
                )

    def action_add_cell_below(self) -> None:
        """Add a new code cell below the focused cell."""
        if self.edit_mode:
            return
        self._add_cell(self.focused_cell_index + 1)

    def action_add_cell_above(self) -> None:
        """Add a new code cell above the focused cell."""
        if self.edit_mode:
            return
        self._add_cell(self.focused_cell_index)

    @work(thread=True)
    def _add_cell(self, index: int) -> None:
        """Add a new cell at the given index."""
        if not self._session:
            return
        try:
            cell_id = self._session.create_cell(
                source="", cell_type="code", index=index
            )
            self.call_from_thread(self._insert_cell_widget, cell_id, index, "code")
        except runtimed.RuntimedError as e:
            self.call_from_thread(
                self.notify, f"Error adding cell: {e}", severity="error"
            )

    def _insert_cell_widget(
        self, cell_id: str, index: int, cell_type: str
    ) -> None:
        """Insert a cell widget at the given index."""
        container = self.query_one("#notebook-container", VerticalScroll)

        # Remove empty placeholder if present
        for child in container.children:
            if "empty-notebook" in child.classes:
                child.remove()
                break

        widget = CellWidget(
            cell_id=cell_id,
            cell_type=cell_type,
            source="",
            execution_count=None,
            outputs=[],
        )

        if index >= len(self._cell_ids):
            container.mount(widget)
            self._cell_ids.append(cell_id)
        else:
            before_id = self._cell_ids[index]
            try:
                before_widget = self.query_one(
                    f"#cell-{before_id}", CellWidget
                )
                container.mount(widget, before=before_widget)
            except NoMatches:
                container.mount(widget)
            self._cell_ids.insert(index, cell_id)

        self._update_cell_count()
        self._focus_cell(index)
        # Auto-enter edit mode on new cell
        self.edit_mode = True
        widget.enter_edit_mode()

    def action_delete_cell(self) -> None:
        """Delete the focused cell."""
        if self.edit_mode or not self._cell_ids:
            return
        cell_id = self._cell_ids[self.focused_cell_index]
        self._delete_cell(cell_id, self.focused_cell_index)

    @work(thread=True)
    def _delete_cell(self, cell_id: str, index: int) -> None:
        """Delete a cell."""
        if not self._session:
            return
        try:
            self._session.delete_cell(cell_id)
            self.call_from_thread(self._remove_cell_widget, cell_id, index)
        except runtimed.RuntimedError as e:
            self.call_from_thread(
                self.notify, f"Error deleting cell: {e}", severity="error"
            )

    def _remove_cell_widget(self, cell_id: str, index: int) -> None:
        """Remove a cell widget."""
        try:
            widget = self.query_one(f"#cell-{cell_id}", CellWidget)
            widget.remove()
        except NoMatches:
            pass

        if cell_id in self._cell_ids:
            self._cell_ids.remove(cell_id)

        self._update_cell_count()

        if not self._cell_ids:
            self._add_empty_placeholder()
        else:
            new_index = min(index, len(self._cell_ids) - 1)
            self._focus_cell(new_index)

    def action_execute_cell(self) -> None:
        """Execute the focused cell."""
        # Sync source if in edit mode
        widget = self._get_focused_cell_widget()
        if widget and widget.cell_type == "code":
            if self.edit_mode:
                widget.exit_edit_mode()
                self.edit_mode = False
            source = widget.get_source()
            self._execute_cell(widget.cell_id, source)

    def action_execute_and_next(self) -> None:
        """Execute the focused cell and move to the next one."""
        self.action_execute_cell()
        # Move to next or create new cell
        if self.focused_cell_index >= len(self._cell_ids) - 1:
            self._add_cell(len(self._cell_ids))
        else:
            self._focus_cell(self.focused_cell_index + 1)

    @work(thread=True)
    def _execute_cell(self, cell_id: str, source: str) -> None:
        """Execute a cell via the daemon."""
        if not self._session:
            return
        try:
            # Sync source first
            self._session.set_source(cell_id, source)
            # Clear previous outputs
            self._session.clear_outputs(cell_id)
            self.call_from_thread(self._clear_cell_outputs, cell_id)
            # Queue for execution (outputs arrive via broadcast)
            self._session.queue_cell(cell_id)
        except runtimed.RuntimedError as e:
            self.call_from_thread(
                self.notify, f"Execution error: {e}", severity="error"
            )

    def _clear_cell_outputs(self, cell_id: str) -> None:
        """Clear outputs for a cell widget."""
        try:
            widget = self.query_one(f"#cell-{cell_id}", CellWidget)
            widget.clear_outputs()
        except NoMatches:
            pass

    def action_run_all(self) -> None:
        """Run all cells."""
        self._run_all_cells()

    @work(thread=True)
    def _run_all_cells(self) -> None:
        """Run all cells via the daemon."""
        if not self._session:
            return
        try:
            # Sync all sources first
            for cell_id in self._cell_ids:
                try:
                    widget = self.query_one(f"#cell-{cell_id}", CellWidget)
                    source = widget.get_source()
                    self._session.set_source(cell_id, source)
                except NoMatches:
                    pass
            self._session.run_all_cells()
        except runtimed.RuntimedError as e:
            self.call_from_thread(
                self.notify, f"Error running all: {e}", severity="error"
            )

    def action_interrupt_kernel(self) -> None:
        """Interrupt the running kernel."""
        self._interrupt_kernel()

    @work(thread=True)
    def _interrupt_kernel(self) -> None:
        if self._session:
            try:
                self._session.interrupt()
                self.call_from_thread(
                    self.notify, "Kernel interrupted", severity="information"
                )
            except runtimed.RuntimedError as e:
                self.call_from_thread(
                    self.notify, f"Interrupt failed: {e}", severity="error"
                )

    def action_save(self) -> None:
        """Save the notebook."""
        self._save_notebook()

    @work(thread=True)
    def _save_notebook(self) -> None:
        if not self._session:
            return
        try:
            # Sync all cell sources before saving
            for cell_id in self._cell_ids:
                try:
                    widget = self.query_one(f"#cell-{cell_id}", CellWidget)
                    source = widget.get_source()
                    self._session.set_source(cell_id, source)
                except NoMatches:
                    pass
            path = self._session.save()
            self.call_from_thread(
                self.notify, f"Saved: {path}", severity="information"
            )
        except runtimed.RuntimedError as e:
            self.call_from_thread(
                self.notify, f"Save error: {e}", severity="error"
            )

    def action_open_notebook(self) -> None:
        """Open a notebook file."""

        def on_path(path: str | None) -> None:
            if path:
                self._open_notebook(path)

        self.push_screen(OpenNotebookScreen(), on_path)

    def action_new_notebook(self) -> None:
        """Create a new notebook."""
        self._create_new_notebook()

    def action_change_cell_type(self) -> None:
        """Change the focused cell's type."""
        if self.edit_mode:
            return

        def on_type(cell_type: str | None) -> None:
            if cell_type:
                widget = self._get_focused_cell_widget()
                if widget:
                    widget.cell_type = cell_type
                    # TODO: sync cell type to daemon when API supports it

        self.push_screen(ChangeCellTypeScreen(), on_type)

    def action_toggle_help(self) -> None:
        """Show/hide help."""
        self.notify(
            "[bold]Key Bindings[/]\n"
            "Enter: Edit  |  Esc: Command mode\n"
            "Shift+Enter: Run  |  Ctrl+Enter: Run & Next\n"
            "a/b: Add above/below  |  dd: Delete\n"
            "j/k: Navigate  |  t: Cell type\n"
            "Ctrl+C: Interrupt  |  Ctrl+S: Save",
            title="Help",
            timeout=10,
        )


def run():
    """CLI entry point with argument parsing."""
    parser = argparse.ArgumentParser(
        description="A rich notebook TUI powered by runtimed"
    )
    parser.add_argument(
        "notebook",
        nargs="?",
        help="Path to .ipynb file to open",
    )
    args = parser.parse_args()

    app = NotebookApp(notebook_path=args.notebook)
    app.run()


if __name__ == "__main__":
    run()
