export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'done' | 'skipped'
  priority: 'high' | 'medium' | 'low'
  position: number
  createdAt: number
}

export class TodoManager {
  private todos: Map<string, TodoItem[]> = new Map()

  get(sessionId: string): TodoItem[] {
    return this.todos.get(sessionId) || []
  }

  update(sessionId: string, todos: TodoItem[]): void {
    this.todos.set(sessionId, todos.sort((a, b) => a.position - b.position))
  }

  add(sessionId: string, content: string, priority: 'high' | 'medium' | 'low' = 'medium'): TodoItem {
    const list = this.get(sessionId)
    const item: TodoItem = {
      id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      status: 'pending',
      priority,
      position: list.length,
      createdAt: Date.now(),
    }
    list.push(item)
    this.todos.set(sessionId, list)
    return item
  }

  markDone(sessionId: string, id: string): void {
    const list = this.get(sessionId)
    const item = list.find(t => t.id === id)
    if (item) item.status = 'done'
  }

  markSkipped(sessionId: string, id: string): void {
    const list = this.get(sessionId)
    const item = list.find(t => t.id === id)
    if (item) item.status = 'skipped'
  }

  remove(sessionId: string, id: string): void {
    const list = this.get(sessionId).filter(t => t.id !== id)
    this.todos.set(sessionId, list)
  }

  clear(sessionId: string): void {
    this.todos.delete(sessionId)
  }

  pendingCount(sessionId: string): number {
    return this.get(sessionId).filter(t => t.status === 'pending').length
  }

  toPrompt(sessionId: string): string {
    const items = this.get(sessionId).filter(t => t.status !== 'skipped')
    if (items.length === 0) return ''
    return items.map(t => `- [${t.status === 'done' ? 'x' : ' '}] ${t.content}`).join('\n')
  }
}

export const defaultTodoManager = new TodoManager()
