import { z } from "zod";
export const denPrioritySchema = z.object({
  action: z.literal("set_den_priorities"), den: z.enum(["0-Lions","1-Tigers","2-Wolves","3-Bears","4-Webelos","5-AOL"]),
  scouting_year: z.string().regex(/^\d{4}-\d{2}$/).refine((s) => String(Number(s.slice(0,4))+1).slice(-2) === s.slice(-2)),
  adventure_ids: z.array(z.string().uuid()).length(2).refine((ids) => new Set(ids).size === 2),
  expected_revision: z.number().int().min(0).max(2147483646),
}).strict();
export const readDenPlansSchema = denPrioritySchema.pick({ scouting_year: true }).strict();
export type DenPlansQuery = z.infer<typeof readDenPlansSchema>;
