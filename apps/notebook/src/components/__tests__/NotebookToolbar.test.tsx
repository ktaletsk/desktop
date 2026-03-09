import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KERNEL_STATUS } from "../../lib/kernel-status";
import { NotebookToolbar } from "../NotebookToolbar";

const baseProps = {
  envSource: null,
  envTypeHint: null,
  dirty: false,
  hasDependencies: false,
  theme: "system" as const,
  envProgress: null,
  runtime: "python",
  onThemeChange: vi.fn(),
  onSave: vi.fn(),
  onStartKernel: vi.fn(),
  onInterruptKernel: vi.fn(),
  onRestartKernel: vi.fn(),
  onRunAllCells: vi.fn(),
  onRestartAndRunAll: vi.fn(),
  onAddCell: vi.fn(),
  onToggleDependencies: vi.fn(),
};

describe("NotebookToolbar kernel errors", () => {
  it("shows the full kernel error only in a hover tooltip", async () => {
    const errorMessage =
      "Failed to start kernel: No such file or directory (os error 2)";

    render(
      <NotebookToolbar
        {...baseProps}
        kernelStatus={KERNEL_STATUS.ERROR}
        kernelErrorMessage={errorMessage}
      />,
    );

    const trigger = screen.getByTestId("kernel-error-status");

    expect(trigger.getAttribute("aria-label")).toBe(
      `Kernel: Error — ${errorMessage}`,
    );
    expect(screen.getByText("error")).toBeTruthy();
    expect(screen.queryByText(errorMessage)).toBeNull();

    fireEvent.focus(trigger);

    await waitFor(() => {
      expect(screen.queryByText(errorMessage)).toBeTruthy();
    });
  });
});
