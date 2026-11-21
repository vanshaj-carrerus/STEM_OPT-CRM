import { notFound } from "next/navigation";
import { loadCandidateFor, requirePage } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { can } from "@/lib/rbac/can";
import { toCandidateView } from "@/lib/candidates/service";
import { todayFor } from "@/lib/immigration/calendar";
import { loadImmigrationOverview } from "@/lib/immigration/overview";
import type { CandidateTabProps } from "../tab-types";
import { ClearanceCard } from "./clearance-card";
import { DetailsCard } from "./details-card";
import { I983Card } from "./i983-card";
import { MilestonesCard } from "./milestones-card";
import { PeriodsCard } from "./periods-card";
import { UnemploymentCard } from "./unemployment-card";

/** Immigration tab: authorization timeline, verification, clearance, I-983, unemployment days, milestones. */
export async function CandidateImmigrationTab({ candidateId }: CandidateTabProps) {
  const user = await requirePage("immigration.view");
  const candidate = await loadCandidateFor(user, candidateId);
  if (!candidate) notFound();

  const today = todayFor(user);
  const o = await loadImmigrationOverview(user, candidate, today);
  const view = toCandidateView(user, candidate);
  const canEdit = can(user, "immigration.edit");
  const canVerify = can(user, "immigration.verify");
  await audit({ actor: user, action: "read", entityType: "immigration", entityId: candidateId, candidateId, summary: "Viewed immigration record" });

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <PeriodsCard
          candidateId={candidateId}
          periods={o.periods}
          employers={o.employers}
          evidence={o.evidenceOptions}
          canEdit={canEdit}
          canVerify={canVerify}
          defaultEducationLevel={candidate.degreeLevel}
        />
        <I983Card candidateId={candidateId} periods={o.periods} evidence={o.evidenceOptions} canEdit={canEdit} canVerify={canVerify} />
        <MilestonesCard milestones={o.milestones} today={today} />
        <UnemploymentCard candidateId={candidateId} data={o.unemployment} canEdit={canEdit} canVerify={canVerify} />
      </div>
      <div className="space-y-5">
        <ClearanceCard candidateId={candidateId} clearance={o.clearance} canEdit={canEdit} canVerify={canVerify} />
        <DetailsCard
          candidateId={candidateId}
          c={view}
          canSevis={can(user, "sensitive.sevis.view")}
          canEad={can(user, "sensitive.ead.view")}
          riskFlags={candidate.riskFlags ?? []}
          cpt={o.cpt}
        />
      </div>
    </div>
  );
}
