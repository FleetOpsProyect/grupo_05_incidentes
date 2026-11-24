export const ASSIGNMENTS_GATEWAY = Symbol('ASSIGNMENTS_GATEWAY');

// Único estado que acepta Incidentes. Los demás (pending, finished, interrupted_by_incident, cancelled)
// provocan 409. Nombres en inglés pendientes de confirmar con Asignaciones (G2).
export const ASSIGNMENT_IN_PROGRESS = 'in_progress';

export interface AssignmentSummary {
  id: string;
  status: string;
  vehicleId: string;
  driverId: string;
}

export interface AssignmentsGateway {
  /** Devuelve `null` si Asignaciones responde 404. Si no está disponible lanza 503 dependency_unavailable. */
  findById(id: string): Promise<AssignmentSummary | null>;
}
