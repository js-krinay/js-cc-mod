import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RequestDetail } from './db'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { span } from '@/lib/insights'
import { fmt, ms, outcomeLabel, seriesColor, sessionName, usd } from '@/lib/view'

const stamp = (t: number) =>
  new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)

function Facts({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v]) => [
        <dt key={`k${k}`} className="text-muted-foreground">{k}</dt>,
        <dd key={`v${k}`} className="min-w-0 break-words">{v ?? '—'}</dd>,
      ])}
    </dl>
  )
}

function CopyText({ text }: { text: string | null }) {
  const [done, setDone] = useState(false)
  if (!text) return <>—</>
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <span className="truncate">{text}</span>
      <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={done ? 'Copied' : `Copy ${text}`}
        onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }) }}>
        {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </span>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

// Everything logged about one request, and the prompt it belongs to. Picking
// another request of that prompt shows it in the same drawer.
export function RequestDrawer({ uid, ttl, order, onOpen, onClose }: {
  uid: string | null; ttl: '1h' | '5m'; order: string[]; onOpen: (uid: string) => void; onClose: () => void
}) {
  const [data, setData] = useState<RequestDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!uid) return
    let live = true
    setError(null)
    fetch(`/api/request?${new URLSearchParams({ uid, ttl })}`, { cache: 'no-store' })
      .then(async res => {
        if (!live) return
        if (res.status === 404) throw new Error('This request is no longer in the index. Refresh the page and pick it again.')
        if (!res.ok) throw new Error(`The dashboard answered ${res.status}. Close this and try again.`)
        setData((await res.json()) as RequestDetail)
      })
      .catch((e: Error) => { if (live) { setData(null); setError(e.message) } })
    return () => { live = false }
  }, [uid, ttl])

  const r = data?.request.uid === uid ? data.request : null
  const prompt = r ? data!.prompt : null
  const sent = r ? (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0) : 0
  const outcome = r?.error ? 'error' : outcomeLabel(r?.stopReason)
  return (
    <Sheet open={uid != null} onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl" data-drawer>
        <SheetHeader className="border-b border-border">
          <SheetTitle className="pr-8">{r ? sessionName(r.sessionTitle, r.sessionId) : error ? 'Request not found' : 'Loading the request…'}</SheetTitle>
          <SheetDescription>
            {r ? <>{r.agentId ? `${r.agentType ?? 'Subagent'}: ${r.agentDescription ?? 'no description'}` : 'Main thread'}, ended {stamp(r.endedAt)}</> : error ?? ''}
          </SheetDescription>
          {r && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Badge variant="outline" className="gap-1.5">
                <span className="size-2 rounded-[2px]" style={{ background: seriesColor(r.modelAnswered ?? r.model ?? '', order) }} />
                {r.modelAnswered ?? r.model ?? 'unknown model'}
              </Badge>
              {r.effort && <Badge variant="outline">{r.effort} effort</Badge>}
              <Badge variant={r.error ? 'destructive' : 'secondary'}>{outcome}</Badge>
            </div>
          )}
        </SheetHeader>

        {r && (
          <div className="flex flex-col gap-6 p-4">
            <Section title="Cost and tokens">
              <Table>
                <TableHeader><TableRow><TableHead>Tokens</TableHead><TableHead className="text-right">Count</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
                <TableBody>
                  {([['Uncached input', r.inputTokens, r.costs.input], ['Cache write', r.cacheWriteTokens, r.costs.cacheWrite],
                    ['Cache read', r.cacheReadTokens, r.costs.cacheRead], ['Output', r.outputTokens, r.costs.output]] as const).map(([k, n, c]) => (
                    <TableRow key={k}><TableCell>{k}</TableCell><TableCell className="text-right tabular-nums">{fmt(n)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.priced ? usd(c) : '—'}</TableCell></TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow><TableCell>Total</TableCell><TableCell className="text-right tabular-nums">{fmt(sent + (r.outputTokens ?? 0))}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.priced ? usd(r.cost) : 'unpriced'}</TableCell></TableRow>
                </TableFooter>
              </Table>
              <p className="text-[13px] text-muted-foreground">
                {pct(r.hit)} of the prompt came from cache. {r.priced ? `Cache writes at the ${ttl === '5m' ? '5-minute' : '1-hour'} rate.` : 'This model has no list price in the price table.'}
              </p>
            </Section>

            <Separator />
            <Section title="Timing and context">
              <Facts items={[
                ['Started', stamp(r.startedAt)], ['Took', ms(r.durationMs)], ['First token after', ms(r.firstChunkMs)],
                ['Prompt size', `${fmt(sent)} tokens`], ['Messages sent', fmt(r.messageCount)],
              ]} />
            </Section>

            <Separator />
            <Section title="Tools">
              {r.toolNames.length + r.serverTools.length === 0 ? <p className="text-sm text-muted-foreground">The reply called no tools.</p> : (
                <div className="flex flex-wrap gap-1.5">
                  {r.toolNames.map((t, i) => <Badge key={`t${i}`} variant="outline">{t}</Badge>)}
                  {r.serverTools.map((t, i) => <Badge key={`s${i}`} variant="secondary">{t} (server)</Badge>)}
                </div>
              )}
              {r.error && <p className="text-sm text-destructive">{r.error}</p>}
            </Section>

            <Separator />
            <Section title="Where it ran">
              <Facts items={[
                ['Machine', r.machine], ['User', r.user], ['Project', r.project], ['Folder', r.cwd], ['Branch', r.branch],
                ['Claude Code', r.engineVersion], ['Logged by', r.source],
              ]} />
            </Section>

            <Separator />
            <Section title="Ids">
              <Facts items={[
                ['Session', <CopyText key="s" text={r.sessionId} />], ['Prompt (turn)', <CopyText key="t" text={r.turnId} />],
                ['Step', r.step == null ? null : fmt(r.step)], ['Subagent', <CopyText key="a" text={r.agentId} />],
              ]} />
            </Section>

            {prompt && (
              <>
                <Separator />
                <Section title="Its prompt">
                  <p className="text-[13px] text-muted-foreground">
                    {fmt(prompt.totals.requests)} {prompt.totals.requests === 1 ? 'request' : 'requests'} over {span(prompt.totals.durationMs)},{' '}
                    {usd(prompt.totals.cost)} in all. A subagent request counts under the prompt that was running when it started. Pick one to see it.
                  </p>
                  <Table>
                    <TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Thread</TableHead><TableHead>Model</TableHead>
                      <TableHead className="text-right">Took</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {prompt.requests.map(m => (
                        <TableRow key={m.uid} data-state={m.uid === r.uid ? 'selected' : undefined}
                          tabIndex={0} className="cursor-pointer" aria-current={m.uid === r.uid ? 'true' : undefined}
                          onClick={() => onOpen(m.uid)} onKeyDown={e => { if (e.key === 'Enter') onOpen(m.uid) }}>
                          <TableCell className="whitespace-nowrap">{new Date(m.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</TableCell>
                          <TableCell className="max-w-[9rem] truncate">{m.agent}</TableCell>
                          <TableCell className="max-w-[10rem] truncate">{m.model}</TableCell>
                          <TableCell className="text-right tabular-nums">{ms(m.durationMs)}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.cost == null ? '—' : usd(m.cost)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Section>
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
