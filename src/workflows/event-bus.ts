import { InProcessBus, realtimeBus } from "../realtime/bus";

export interface WorkflowEventBus {
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;
}

export class InProcessEventBus implements WorkflowEventBus {
  constructor(private readonly bus = new InProcessBus()) {}

  emit(event: string, data: unknown): void {
    this.bus.publish(`workflow:${event}`, data);
  }

  on(event: string, handler: (data: unknown) => void): void {
    this.bus.subscribe(`workflow:${event}`, handler);
  }

  off(event: string, handler: (data: unknown) => void): void {
    this.bus.unsubscribe(`workflow:${event}`, handler);
  }
}

export const workflowEventBus: WorkflowEventBus = new InProcessEventBus(realtimeBus);
