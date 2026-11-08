import { z } from "zod";
const uuid = z.string().uuid();
export const inventoryCategories = ["required_badge", "elective_badge", "neckerchief", "slider", "book", "rank_insignia", "other"] as const;
const quantity = z.number().int().min(0).max(1000000);
const common = { item_id: uuid, occurred_on: z.iso.date().optional(), note: z.string().trim().min(1).max(500) };
const update = { ...common, expected_revision: z.number().int().min(1).max(2147483646) };
export const inventoryOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("define_inventory_item"), ...common, name: z.string().trim().min(1).max(200), den: z.enum(["0-Lions", "1-Tigers", "2-Wolves", "3-Bears", "4-Webelos", "5-AOL"]).optional(), category: z.enum(inventoryCategories), quantity: quantity.optional(), counted_on: z.iso.date().optional(), source_context: z.record(z.string(), z.string().max(500)).optional() }).strict(),
  z.object({ action: z.literal("inventory_count"), ...update, quantity }).strict(),
  z.object({ action: z.literal("inventory_receive"), ...update, quantity: quantity.min(1) }).strict(),
  z.object({ action: z.literal("inventory_issue"), ...update, quantity: quantity.min(1) }).strict(),
]);
export const readInventorySchema = z.object({ entity: z.enum(["items", "events"]), item_id: uuid.optional(), page_offset: z.number().int().min(0).max(10000).default(0), page_limit: z.number().int().min(1).max(100).default(50) }).strict();
export type InventoryQuery = z.infer<typeof readInventorySchema>;
export const inventoryGuide = "Inventory is stock on hand, separate from scout loans, distributions, badge delivery and purchases. Never automatically subtract old or new scout handouts from inventory. Read items/current revision first. Missing quantities mean unknown, not zero; record an actual inventory_count before receiving or issuing against unknown stock. inventory_receive adds, inventory_issue subtracts, inventory_count replaces the current balance after a physical count/correction. Notes and actual dates are required; counts/stock changes keep immutable history. Stable request IDs provide safe retries. Items with similar names remain distinct unless the leader confirms they are the same physical stock. This inventory is pack-wide, not scoped to a scouting year.";
