/** Lightweight event sourcing adapted from opencode's EventV2.
 *  Uses localStorage for persistence and EventEmitter for in-memory PubSub.
 */

interface EventPayload {
  id: string
  type: string
  seq: number
  aggregateID: string
  timestamp: number
  data: Record<string, unknown>
}

type EventDefinition = {
  type: string
  data: { new(...args: any[]): any }
  durable?: { version: number }
}

type Subscriber = (event: EventPayload) => void

const subscribers = new Map<string, Set<Subscriber>>()
const allSubscribers = new Set<Subscriber>()
let sequenceCounter = 0

function getStorageKey(aggregateID: string): string {
  return `bowow-events-${aggregateID}`
}

/** Generate unique event IDs */
function nextID(): string {
  return `evt_${++sequenceCounter}_${Date.now()}`
}

/** Publish an event to durable storage and in-memory subscribers */
export function publish(type: string, aggregateID: string, data: Record<string, unknown>) {
  const events = loadEvents(aggregateID)
  const seq = events.length
  const event: EventPayload = {
    id: nextID(),
    type,
    seq,
    aggregateID,
    timestamp: Date.now(),
    data,
  }
  events.push(event)
  saveEvents(aggregateID, events)
  notifySubscribers(event)
  return event
}

/** Read all events for an aggregate */
export function readAggregate(aggregateID: string, afterSeq = -1): EventPayload[] {
  const events = loadEvents(aggregateID)
  return events.filter(e => e.seq > afterSeq)
}

/** Project events into a state object using reducer functions */
export function project<T>(
  aggregateID: string,
  reducers: Record<string, (state: T, event: EventPayload) => T>,
  initialState: T,
): T {
  const events = loadEvents(aggregateID)
  return events.reduce((state, event) => {
    const reducer = reducers[event.type]
    return reducer ? reducer(state, event) : state
  }, initialState)
}

/** Subscribe to specific event types (or all events) */
export function subscribe(type: string | null, callback: Subscriber): () => void {
  if (type === null) {
    allSubscribers.add(callback)
    return () => allSubscribers.delete(callback)
  }
  let set = subscribers.get(type)
  if (!set) {
    set = new Set()
    subscribers.set(type, set)
  }
  set.add(callback)
  return () => set!.delete(callback)
}

/** Register durable event definition (needed for proper deserialization) */
const definitions = new Map<string, EventDefinition>()
export function registerDefinition(def: EventDefinition) {
  definitions.set(def.type, def)
}

function loadEvents(aggregateID: string): EventPayload[] {
  try {
    const raw = localStorage.getItem(getStorageKey(aggregateID))
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveEvents(aggregateID: string, events: EventPayload[]) {
  try {
    localStorage.setItem(getStorageKey(aggregateID), JSON.stringify(events))
  } catch {}
}

function notifySubscribers(event: EventPayload) {
  const typeSubs = subscribers.get(event.type)
  if (typeSubs) typeSubs.forEach(cb => cb(event))
  allSubscribers.forEach(cb => cb(event))
}

/** Clear all events for an aggregate */
export function clearAggregate(aggregateID: string) {
  try {
    localStorage.removeItem(getStorageKey(aggregateID))
  } catch {}
}

/** Timeline event helpers */
export const SessionEvents = {
  MessageAdded: 'session.message_added',
  FileCreated: 'session.file_created',
  FileEdited: 'session.file_edited',
  ToolExecuted: 'session.tool_executed',
  CommandRun: 'session.command_run',
}

export function publishTimelineEvent(
  buildId: number,
  type: string,
  data: Record<string, unknown>,
): EventPayload {
  return publish(type, `build_${buildId}`, data)
}

export function projectTimeline(
  buildId: number,
): EventPayload[] {
  return readAggregate(`build_${buildId}`)
}
