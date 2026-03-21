import { NextRequest, NextResponse } from 'next/server';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { getFirebaseStorage } from '@/lib/firebase';
import { v4 as uuidv4 } from 'uuid';

export async function POST(request: NextRequest) {
  // Upload feature gate — disabled by default for Sprint 5A
  if (process.env.UPLOADS_ENABLED !== "true") {
    return NextResponse.json(
      { error: "File uploads are currently disabled" },
      { status: 403 }
    );
  }

  try {
    const formData = await request.formData();
    const files = formData.getAll('photos') as File[];
    const jobId = formData.get('jobId') as string || uuidv4();

    if (!files.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const uploadPromises = files.map(async (file) => {
      if (!file.type.startsWith('image/')) {
        throw new Error(`File ${file.name} is not an image`);
      }

      // Create unique filename
      const fileName = `jobs/${jobId}/${uuidv4()}-${file.name}`;
      const storageRef = ref(getFirebaseStorage(), fileName);

      // Convert file to buffer
      const buffer = await file.arrayBuffer();
      const fileBuffer = Buffer.from(buffer);

      // Upload to Firebase Storage
      const snapshot = await uploadBytes(storageRef, fileBuffer, {
        contentType: file.type,
      });

      // Get download URL
      const downloadURL = await getDownloadURL(snapshot.ref);

      return {
        originalName: file.name,
        url: downloadURL,
        size: file.size,
        type: file.type,
      };
    });

    const uploadedFiles = await Promise.all(uploadPromises);

    return NextResponse.json({
      success: true,
      files: uploadedFiles,
      jobId,
    });

  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: `Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
}

// Handle OPTIONS request for CORS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}