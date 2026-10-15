import { useEffect, useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ToolConnection } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

const roles = ["owner", "admin", "operator"] as const;
export function ExecutionReviewPanel({ connection, canConfigure }: { connection: ToolConnection; canConfigure: boolean }) {
  const id = useId();
  const queryClient = useQueryClient();
  const config = connection.config.executionReview as { approverRoles?: string[] };
  const [selected, setSelected] = useState<string[]>(config.approverRoles ?? []);
  useEffect(() => { setSelected(config.approverRoles ?? []); }, [config.approverRoles]);
  const save = useMutation({
    mutationFn: () => toolsApi.updateConnection(connection.id, {
      config: { ...connection.config, executionReview: { ...config, approverRoles: selected } },
    }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connection.id) }); },
  });
  return <section aria-labelledby={`${id}-heading`} className="space-y-3">
    <h2 id={`${id}-heading`} className="text-lg font-semibold">Production approval</h2>
    <p className="text-sm text-muted-foreground">Every production change requires a separate review. Members with a selected role can approve or reject it in Slack or Paperclip. Permissions cannot be remembered.</p>
    <fieldset disabled={!canConfigure || save.isPending} className="space-y-2">
      <legend className="text-sm font-medium">Roles allowed to review production changes</legend>
      {roles.map(role => <Label key={role} className="flex items-center gap-2">
        <Checkbox checked={selected.includes(role)} onCheckedChange={checked => setSelected(previous => checked ? [...previous, role] : previous.filter(item => item !== role))} />
        {role[0]!.toUpperCase() + role.slice(1)}
      </Label>)}
    </fieldset>
    {canConfigure && <Button disabled={selected.length === 0 || save.isPending} onClick={() => save.mutate()}>Save approval roles</Button>}
    {selected.length === 0 && <p className="text-sm text-destructive">Select at least one role.</p>}
    {save.isError && <p role="alert" className="text-sm text-destructive">Could not save approval roles. Your saved policy is unchanged.</p>}
    {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Approval roles saved.</p>}
  </section>;
}
