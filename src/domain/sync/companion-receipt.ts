import type {CompanionActivityResult} from './delivery-contracts';
export function isDurableCompanionAck(receipt: CompanionActivityResult | undefined): boolean {
  if (receipt?.projectionStatus === "pending" || receipt?.companionReceipt?.projectionStatus === "pending") return false;
  if (receipt?.status === "duplicate") return true;
  return receipt?.status === "accepted" && receipt.companionReceipt?.durable === true;
}
