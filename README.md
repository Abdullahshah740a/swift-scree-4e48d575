# Swift Screen

Swift Screen is a browser-based screen recording and video-sharing application designed for capturing demonstrations, tutorials, walkthroughs, and updates. It allows users to record their screen and camera, organize recordings, share videos, and collaborate through timestamped feedback.

The application combines screen recording, cloud storage, video playback, transcription, and asynchronous collaboration in one interface.

## Features

### 🎥 Screen and Camera Recording
- Capture an entire screen, application window, or browser tab.
- Record webcam video independently or combine it with screen capture using a camera overlay.
- Capture microphone narration and supported system audio, depending on browser capabilities and granted permissions.
- Start, pause, resume, and stop recordings with an elapsed-time display.
- Preview recordings after capture.

### 💾 Storage and Recovery
- Cache recordings locally in browser IndexedDB.
- Upload recordings to Supabase Storage.
- Retry failed uploads using **Sync to Cloud** on the device containing the local recording.
- Preserve recording metadata separately in JSON format.

### 📁 Video Library and Organization
- Browse recordings and recent activity.
- Edit recording titles, descriptions, and other details.
- Organize recordings into folders and move videos between folders.
- Delete recordings when they are no longer needed.

### ▶️ Video Playback
- Play and pause recordings.
- Seek forward and backward through videos.
- Adjust volume, mute audio, and use fullscreen playback.
- Repair WebM duration metadata and seeking indexes for newly created recordings.
- Prepare a repaired local copy of older recordings with invalid duration metadata.

### 🔗 Sharing and Downloads
- Copy shareable viewer links.
- Generate iframe embed code for integrating videos into supported pages.
- Download recordings in WebM or MP4 format according to the actual media container.

### 💬 Timestamped Collaboration
- Add comments and emoji reactions at specific playback timestamps.
- Navigate directly to moments associated with comments and reactions.
- Share feedback asynchronously without requiring participants to watch together.

### 📝 Automatic Transcription
- Generate timestamped speech transcripts directly in the browser using Whisper.
- Display transcription progress.
- Navigate through recordings using clickable transcript segments.

## Recording Workflow

1. **Select a recording source:** Open the recording page and choose screen, camera, or screen plus camera. Optionally enter an author name.
2. **Grant permissions and record:** Allow the required browser permissions, then record the desired content. Pause and resume as needed.
3. **Finalize the recording:** Stop recording to assemble the captured media chunks and generate a thumbnail. WebM recordings are prepared with duration metadata and a seek index.
4. **Save the recording:** Keep a browser-local copy and upload the video through the server to Supabase Storage. Store descriptive metadata separately as JSON.
5. **Review and organize:** Preview the recording, update its title and description, and organize it using the video library and folder controls.
6. **Share and collaborate:** Copy a viewer link or embed code. Viewers can watch the recording and add timestamped comments, reactions, or a generated transcript.
7. **Recover or download:** If an upload fails, use **Sync to Cloud** on the original device to retry. Download the video when an offline copy is needed.

## Technology Stack

| Technology | Role |
|---|---|
| **React and TypeScript** | Build the user interface and provide typed application logic. |
| **TanStack Start and TanStack Router** | Handle application routing, server functions, and upload and playback endpoints. |
| **TanStack Query** | Fetch and cache recording data and refresh the interface after changes. |
| **Browser Media APIs** | Use `MediaRecorder`, `getDisplayMedia`, `getUserMedia`, Canvas, and Web Audio for recording, capture, and media composition. |
| **Supabase Storage** | Store video files in cloud storage. |
| **IndexedDB** | Maintain browser-local recordings for playback and recovery. |
| **ts-ebml** | Rebuild WebM duration metadata and seeking cues without re-encoding media frames. |
| **Transformers.js and Whisper** | Run browser-based speech recognition using the Whisper base model and WebAssembly. |
| **Tailwind CSS and Radix UI** | Style the interface and provide reusable, accessible UI components. |
| **Lucide** | Supply interface icons. |
| **Sonner** | Display application notifications. |
| **Vite and Node.js** | Support development, production builds, and automated regression tests. |
| **ESLint and Prettier** | Maintain code quality and consistent source formatting. |
| **Zod** | Validate supported server-function inputs. |

## Browser Compatibility

Swift Screen relies on browser media APIs for recording and playback. Available features depend on the browser, operating system, permissions, and selected recording source.

- Screen and window capture require browser support for the relevant display-capture APIs.
- Microphone and camera recording require permission to access the corresponding devices.
- System audio capture varies by browser and operating system.
- Browser-based transcription requires the necessary model assets and supported execution capabilities.

## Storage and Privacy

Swift Screen uses browser-local storage and Supabase Storage to support recording persistence and recovery.

- Local recordings may remain available on the original browser and device.
- Cloud uploads depend on server configuration, storage availability, and network connectivity.
- Recording and transcription capabilities require the relevant browser permissions and resources.

Avoid recording or sharing confidential information unless you have the necessary authorization. Configure cloud storage access and sharing permissions appropriately for your deployment.

## Project Summary

Swift Screen brings together browser-based recording, cloud-backed video storage, playback, video organization, timestamped collaboration, and automatic transcription. It is designed to make recording and sharing visual information straightforward, while supporting asynchronous communication and recovery from failed uploads.
