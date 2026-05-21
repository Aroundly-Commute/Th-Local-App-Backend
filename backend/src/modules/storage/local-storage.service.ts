import { Injectable } from '@nestjs/common';
import { StorageService } from './storage.service';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class LocalStorageService implements StorageService {
  private readonly basePath = path.join(process.cwd(), 'uploads');
  // Since we are running in docker typically, we should use an accessible domain or let the frontend resolve it.
  // We'll use a relative-like path or a configured env variable.
  private readonly baseUrl = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:3000'; 

  constructor() {
    this.ensureDirectoryExists(this.basePath);
  }

  private async ensureDirectoryExists(dirPath: string) {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
      console.error(`Error creating directory ${dirPath}:`, error);
    }
  }

  async uploadFile(file: Express.Multer.File, directory = ''): Promise<string> {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const originalExt = path.extname(file.originalname);
    const filename = uniqueSuffix + originalExt;
    
    const targetDir = path.join(this.basePath, directory);
    await this.ensureDirectoryExists(targetDir);
    
    const filePath = path.join(targetDir, filename);
    await fs.writeFile(filePath, file.buffer);
    
    // Convert to URL structure.
    const urlPath = `/uploads/${directory ? directory + '/' : ''}${filename}`;
    return `${this.baseUrl}${urlPath}`; 
  }

  async deleteFile(fileUrl: string): Promise<void> {
    try {
      const urlPath = new URL(fileUrl).pathname; // e.g., /uploads/dir/file.jpg
      const filePath = path.join(process.cwd(), urlPath);
      await fs.unlink(filePath);
    } catch (e) {
      console.warn(`Failed to delete file at ${fileUrl}`, e);
    }
  }
}
