import { Type } from 'class-transformer';
import { IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min, ValidateNested } from 'class-validator';

class LngLatDto {
  @IsNumber()
  @Type(() => Number)
  lng!: number;

  @IsNumber()
  @Type(() => Number)
  lat!: number;
}

export class RequestRideDto {
  @IsUUID()
  rideId!: string;

  @IsString()
  @IsNotEmpty()
  riderName!: string;

  @IsString()
  @IsNotEmpty()
  riderStartName!: string;

  @IsString()
  @IsNotEmpty()
  riderEndName!: string;

  @IsDateString()
  riderStartTime!: string;

  @ValidateNested()
  @Type(() => LngLatDto)
  riderStart!: LngLatDto;

  @ValidateNested()
  @Type(() => LngLatDto)
  riderEnd!: LngLatDto;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  seats?: number;
}

