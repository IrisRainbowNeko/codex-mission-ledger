import type { HostApproval } from "../core/contracts.js";
import type { ApprovalPolicy, ApprovalsReviewer } from "./types.js";

export interface ChildApprovalSettings {
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer: ApprovalsReviewer;
}

export function childApprovalSettings(
  hostApproval: HostApproval | undefined,
): ChildApprovalSettings {
  return hostApproval === "approveForMe"
    ? { approvalPolicy: "on-request", approvalsReviewer: "auto_review" }
    : { approvalPolicy: "never", approvalsReviewer: "user" };
}
