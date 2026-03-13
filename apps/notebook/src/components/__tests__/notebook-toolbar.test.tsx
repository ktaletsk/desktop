import { render, screen } from "@testing-library/react";
import { NotebookToolbar } from "../NotebookToolbar";
import { KERNEL_STATUS } from "../../lib/kernel-status";

describe("NotebookToolbar", () => {
  it("keeps run controls on one line and uses higher-contrast icon styling", () => {
    render(
      <NotebookToolbar
        kernelStatus={KERNEL_STATUS.IDLE}
        kernelErrorMessage={null}
        envSource={null}
        dirty={false}
        envProgress={null}
        onSave={() => {}}
        onStartKernel={() => {}}
        onInterruptKernel={() => {}}
        onRestartKernel={() => {}}
        onRunAllCells={() => {}}
        onRestartAndRunAll={() => {}}
        onAddCell={() => {}}
        onToggleDependencies={() => {}}
      />,
    );

    expect(screen.getByTestId("run-all-button")).toHaveClass("whitespace-nowrap");
    expect(screen.getByTestId("run-all-button")).toHaveClass(
      "[&_svg]:text-slate-600",
    );
    expect(screen.getByTestId("restart-kernel-button")).toHaveClass(
      "whitespace-nowrap",
    );
  });
});
