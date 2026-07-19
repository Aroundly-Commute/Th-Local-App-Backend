import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

class LngLatDto {
  @IsNumber()
  lng!: number;

  @IsNumber()
  lat!: number;
}

export class CreateRecurringRideDto {
  @IsInt({ each: true })
  @IsArray()
  daysOfWeek!: number[]; // 0 for Sunday, 1 for Monday, etc.

  @IsString()
  @IsNotEmpty()
  timeOfDay!: string; // "HH:MM" e.g., "09:00"

  @IsInt()
  @Min(1)
  @IsOptional()
  durationMinutes?: number;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  @IsOptional()
  endDate?: string;

  @IsInt()
  @Min(0)
  chargeCents!: number;

  @IsInt()
  @Min(1)
  seatsAvailable!: number;

  @IsOptional()
  @IsString()
  fuelType?: string;

  @IsOptional()
  @IsString()
  vehicleType?: string;

  @IsOptional()
  @IsInt()
  vehicleCapacity?: number;

  @IsOptional()
  @IsString()
  vehicleNumber?: string;

  @IsString()
  @IsNotEmpty()
  startPlaceName!: string;

  @IsString()
  @IsNotEmpty()
  endPlaceName!: string;

  @ValidateNested()
  @Type(() => LngLatDto)
  start!: LngLatDto;

  @ValidateNested()
  @Type(() => LngLatDto)
  end!: LngLatDto;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => LngLatDto)
  route!: LngLatDto[];
}
