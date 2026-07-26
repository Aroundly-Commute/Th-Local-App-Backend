import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit() {
    await this.$connect();
    await this.ensurePostgisAndSrid();
  }

  private async ensurePostgisAndSrid() {
    try {
      // 1. Ensure PostGIS extension is enabled
      await this.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS postgis;`);

      // 2. Check if SRID 4326 exists in spatial_ref_sys
      const sridExists: any[] = await this.$queryRawUnsafe(`
        SELECT srid FROM spatial_ref_sys WHERE srid = 4326 LIMIT 1;
      `);

      if (!sridExists || sridExists.length === 0) {
        console.log('SRID 4326 is missing from spatial_ref_sys. Populating...');
        await this.$executeRawUnsafe(`
          INSERT INTO spatial_ref_sys (srid, auth_name, auth_srid, srtext, proj4text)
          VALUES (
            4326, 
            'EPSG', 
            4326, 
            'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]', 
            '+proj=longlat +datum=WGS84 +no_defs'
          ) ON CONFLICT (srid) DO NOTHING;
        `);
        console.log('SRID 4326 successfully populated.');
      }
    } catch (error) {
      console.error('Failed to verify/populate PostGIS SRID 4326:', error);
    }
  }
}

