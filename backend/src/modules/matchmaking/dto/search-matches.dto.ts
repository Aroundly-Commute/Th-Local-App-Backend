import { Type } from 'class-transformer';
import { IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

class LngLatDto {
  @IsNumber()
  lng!: number;

  @IsNumber()
  lat!: number;
}

export class SearchMatchesDto {
  @ValidateNested()
  @Type(() => LngLatDto)
  start!: LngLatDto;

  @ValidateNested()
  @Type(() => LngLatDto)
  end!: LngLatDto;

  @IsString()
  @IsNotEmpty()
  startPlaceName!: string;

  @IsString()
  @IsNotEmpty()
  endPlaceName!: string;

  @IsDateString()
  startTime!: string;

  // Matching knobs (meters / minutes)
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  startRadiusMeters?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  endRadiusMeters?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  corridorMeters?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  timeWindowMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  seats?: number;
}

