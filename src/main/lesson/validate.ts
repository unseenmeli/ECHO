import type { DataSeries } from './types'
import type { VisualOp, VisualPlan } from './ops'
import { USER_REF, type World } from './world'

export interface ValidationContext {
  world: World
  sentenceCount: number
  data: DataSeries[]
}

/**
 * Semantic checks the schema cannot express: ids must exist (or be new),
 * nothing may touch the user's drawings, and charts may only reference
 * supplied data. Returns human-readable problems the visuals agent can fix.
 */
export function validatePlan(plan: VisualPlan, ctx: ValidationContext): string[] {
  const errors: string[] = []
  const { world } = ctx

  const blocks = new Set<string>()
  const known = new Set<string>()
  for (const e of world.echoElements()) {
    if (!e.echo) continue
    known.add(e.echo.id)
    if (e.echo.block) blocks.add(e.echo.block)
  }
  const echoOwned = new Set(known)
  const dataIds = new Set(ctx.data.map((d) => d.id))
  const fresh = (id: string, what: string): boolean => {
    if (known.has(id) || blocks.has(id)) {
      errors.push(`${what} id "${id}" is already used; choose a new id or modify the existing element`)
      return false
    }
    return true
  }
  const exists = (ref: string, what: string, allowUser = false): boolean => {
    if (ref.startsWith(USER_REF)) {
      if (allowUser && world.resolve(ref)) return true
      errors.push(`${what}: "${ref}" ${allowUser ? 'is not a user element on the board' : 'is a user element; you may only reference your own elements here'}`)
      return false
    }
    if (known.has(ref) || blocks.has(ref)) return true
    errors.push(`${what}: unknown element id "${ref}". Known ids: ${[...known].slice(0, 20).join(', ') || '(none yet)'}`)
    return false
  }
  const register = (id: string, block?: string): void => {
    known.add(id)
    echoOwned.add(id)
    if (block) blocks.add(block)
  }

  const check = (op: VisualOp, where: string): void => {
    switch (op.op) {
      case 'diagram': {
        if (!fresh(op.id, `${where} diagram`)) return
        const ids = new Set<string>()
        for (const n of op.nodes) {
          if (ids.has(n.id)) errors.push(`${where} diagram "${op.id}": duplicate node id "${n.id}"`)
          else if (known.has(n.id) || blocks.has(n.id)) errors.push(`${where} diagram "${op.id}": node id "${n.id}" already exists on the board`)
          ids.add(n.id)
        }
        for (const e of op.edges ?? []) {
          if (!ids.has(e.from) || !ids.has(e.to)) errors.push(`${where} diagram "${op.id}": edge ${e.from}->${e.to} must connect nodes of this diagram`)
          if (e.from === e.to) errors.push(`${where} diagram "${op.id}": edge ${e.from}->${e.to} connects a node to itself`)
        }
        blocks.add(op.id)
        for (const n of op.nodes) register(n.id, op.id)
        return
      }
      case 'add': {
        if (!op.nodes?.length && !op.edges?.length) errors.push(`${where} add: provide nodes and/or edges`)
        if (op.diagram && !blocks.has(op.diagram)) errors.push(`${where} add: unknown diagram "${op.diagram}"`)
        if (op.near) exists(op.near, `${where} add.near`)
        const newIds = new Set<string>()
        for (const n of op.nodes ?? []) {
          if (known.has(n.id) || blocks.has(n.id) || newIds.has(n.id)) errors.push(`${where} add: node id "${n.id}" already exists`)
          newIds.add(n.id)
        }
        for (const e of op.edges ?? []) {
          for (const end of [e.from, e.to]) if (!newIds.has(end) && !known.has(end)) errors.push(`${where} add: edge endpoint "${end}" does not exist`)
        }
        for (const id of newIds) register(id, op.diagram ?? undefined)
        return
      }
      case 'chart': {
        if (!fresh(op.id, `${where} chart`)) return
        if (!dataIds.has(op.data)) errors.push(`${where} chart "${op.id}": data "${op.data}" was not supplied. Supplied data ids: ${[...dataIds].join(', ') || '(none)'}. Do not chart numbers you invented.`)
        register(op.id, op.id)
        return
      }
      case 'table': {
        if (!fresh(op.id, `${where} table`)) return
        op.rows.forEach((r, i) => {
          if (r.length !== op.columns.length) errors.push(`${where} table "${op.id}": row ${i} has ${r.length} cells but there are ${op.columns.length} columns`)
        })
        register(op.id, op.id)
        return
      }
      case 'timeline': {
        if (!fresh(op.id, `${where} timeline`)) return
        const ids = new Set<string>()
        for (const ev of op.events) {
          if (ids.has(ev.id) || known.has(ev.id)) errors.push(`${where} timeline "${op.id}": event id "${ev.id}" is not unique`)
          ids.add(ev.id)
        }
        register(op.id, op.id)
        for (const id of ids) register(id, op.id)
        return
      }
      case 'note': {
        if (!fresh(op.id, `${where} note`)) return
        if (op.near) exists(op.near, `${where} note.near`, true)
        register(op.id)
        return
      }
      case 'highlight':
        for (const t of op.targets) exists(t, `${where} highlight`, true)
        return
      case 'unhighlight':
        return
      case 'update':
        if (!op.label && !op.detail && !op.color) errors.push(`${where} update "${op.id}": nothing to change`)
        if (!echoOwned.has(op.id)) errors.push(`${where} update: "${op.id}" is not an element you created`)
        return
      case 'move':
        if (!echoOwned.has(op.id)) errors.push(`${where} move: "${op.id}" is not an element you created`)
        exists(op.near, `${where} move.near`, true)
        if (op.id === op.near) errors.push(`${where} move: an element cannot be placed next to itself`)
        return
      case 'group':
        if (!fresh(op.id, `${where} group`)) return
        for (const m of op.members) exists(m, `${where} group member`)
        register(op.id)
        return
      case 'remove':
        for (const id of op.ids) {
          if (!echoOwned.has(id) && !blocks.has(id)) errors.push(`${where} remove: "${id}" is not something you created (the user's drawings can never be removed)`)
        }
        return
      case 'focus':
        for (const t of op.targets) exists(t, `${where} focus`, true)
        return
    }
  }

  plan.setup.forEach((op, i) => check(op, `setup[${i}]`))
  const cues = [...plan.cues].sort((a, b) => a.sentence - b.sentence)
  cues.forEach((c, ci) => {
    if (c.sentence >= ctx.sentenceCount) errors.push(`cues[${ci}]: sentence ${c.sentence} does not exist (the narration has ${ctx.sentenceCount} sentence${ctx.sentenceCount === 1 ? '' : 's'}, numbered from 0)`)
    c.ops.forEach((op, i) => check(op, `cues[${ci}].ops[${i}]`))
  })

  if (plan.no_visual && (plan.setup.length || plan.cues.length)) errors.push('no_visual is true but setup/cues are not empty')
  if (!plan.no_visual && plan.setup.length === 0 && plan.cues.length === 0) errors.push('the plan is empty; set no_visual to true if nothing should be drawn')
  return errors
}
