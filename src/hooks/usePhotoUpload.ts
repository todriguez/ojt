import { useState } from 'react';

interface PhotoUpload {
  file: File;
  preview: string;
  id: string;
  uploaded?: boolean;
  url?: string;
}

interface UploadResult {
  success: boolean;
  files: Array<{
    originalName: string;
    url: string;
    size: number;
    type: string;
  }>;
  jobId: string;
}

export function usePhotoUpload() {
  const [photos, setPhotos] = useState<PhotoUpload[]>([]);
  const [uploading, setUploading] = useState(false);

  // Add photos to queue
  const addPhotos = (files: FileList | File[]) => {
    const fileArray = Array.from(files);

    fileArray.forEach((file) => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const photo: PhotoUpload = {
            file,
            preview: e.target?.result as string,
            id: Date.now() + Math.random().toString(),
            uploaded: false,
          };
          setPhotos(prev => [...prev, photo]);
        };
        reader.readAsDataURL(file);
      }
    });
  };

  // Remove photo from queue
  const removePhoto = (photoId: string) => {
    setPhotos(prev => prev.filter(p => p.id !== photoId));
  };

  // Upload all photos
  const uploadPhotos = async (jobId?: string): Promise<string[]> => {
    if (photos.length === 0) return [];

    setUploading(true);

    try {
      const formData = new FormData();

      // Add all photos to form data
      photos.forEach((photo) => {
        if (!photo.uploaded) {
          formData.append('photos', photo.file);
        }
      });

      if (jobId) {
        formData.append('jobId', jobId);
      }

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const result: UploadResult = await response.json();

      if (!result.success) {
        throw new Error('Upload failed');
      }

      // Update photos with uploaded URLs
      setPhotos(prev =>
        prev.map(photo => {
          const uploadedFile = result.files.find(f => f.originalName === photo.file.name);
          if (uploadedFile) {
            return {
              ...photo,
              uploaded: true,
              url: uploadedFile.url,
            };
          }
          return photo;
        })
      );

      return result.files.map(f => f.url);

    } catch (error) {
      console.error('Photo upload error:', error);
      throw error;
    } finally {
      setUploading(false);
    }
  };

  // Clear all photos
  const clearPhotos = () => {
    setPhotos([]);
  };

  // Get uploaded photo URLs
  const getUploadedUrls = (): string[] => {
    return photos
      .filter(p => p.uploaded && p.url)
      .map(p => p.url!);
  };

  // Validate photo before adding
  const validatePhoto = (file: File): string | null => {
    if (!file.type.startsWith('image/')) {
      return 'File must be an image';
    }

    if (file.size > 10 * 1024 * 1024) { // 10MB limit
      return 'Image must be less than 10MB';
    }

    return null;
  };

  return {
    photos,
    uploading,
    addPhotos,
    removePhoto,
    uploadPhotos,
    clearPhotos,
    getUploadedUrls,
    validatePhoto,
  };
}