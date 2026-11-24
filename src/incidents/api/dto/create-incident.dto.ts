import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { Severity } from '../../domain/severity';

// ISO 8601 con hora y offset obligatorio (Z o ±hh:mm): `@IsISO8601` solo acepta también fechas sin offset.
const ISO_8601_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export class CreateIncidentDto {
  @ApiProperty({
    format: 'uuid',
    example: '3f2b8c1e-5a7d-4e0b-9c64-1d2e3f4a5b6c',
  })
  @IsUUID()
  assignment_id: string;

  @ApiProperty({ enum: Severity, example: Severity.Minor })
  @IsEnum(Severity)
  severity: Severity;

  @ApiProperty({ maxLength: 2000, example: 'Llanta pinchada en la vía' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  description: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-28T09:30:00-05:00' })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(ISO_8601_WITH_OFFSET)
  reported_at: string;
}
