import { Injectable } from '@nestjs/common';
import { CreateIncidentContext } from './create-incident.context';
import { ValidationHandler } from './validation-handler';

@Injectable()
export class VehicleExistsValidator extends ValidationHandler<CreateIncidentContext> {
  protected validate(_context: CreateIncidentContext): Promise<void> {
    // TODO(HU_FLEETOPS_INC_03): consultar VehiclesGateway y lanzar 404 vehicle_not_found.
    return Promise.resolve();
  }
}
