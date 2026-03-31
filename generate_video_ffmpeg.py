"""Generate video using ffmpeg directly - much faster for static slides + audio."""

import os, subprocess, json

BASE = r"c:\MyProjects\AWS\Prompt2TestUI"
SLIDES_DIR = os.path.join(BASE, "slides_img")
AUDIO_DIR = os.path.join(BASE, "slides_audio")
CLIPS_DIR = os.path.join(BASE, "slides_clips")
OUTPUT = os.path.join(BASE, "AI_Agents_MCP_Agentic_Workflows.mp4")

# ffmpeg from imageio_ffmpeg
from imageio_ffmpeg import get_ffmpeg_exe
FFMPEG = get_ffmpeg_exe()

os.makedirs(CLIPS_DIR, exist_ok=True)

def get_duration(audio_path):
    """Get audio duration in seconds using ffprobe."""
    result = subprocess.run(
        [FFMPEG.replace("ffmpeg.exe", "ffprobe.exe") if os.path.exists(FFMPEG.replace("ffmpeg.exe", "ffprobe.exe")) else FFMPEG,
         "-v", "quiet", "-print_format", "json", "-show_format", audio_path],
        capture_output=True, text=True
    )
    # Fallback: use ffmpeg to get duration
    result = subprocess.run(
        [FFMPEG, "-i", audio_path, "-f", "null", "-"],
        capture_output=True, text=True
    )
    # Parse duration from stderr
    for line in result.stderr.split("\n"):
        if "Duration:" in line:
            time_str = line.split("Duration:")[1].split(",")[0].strip()
            parts = time_str.split(":")
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
    return 60  # fallback

def create_clip(slide_num, img_path, audio_path, clip_path):
    """Create a single clip: static image + audio."""
    duration = get_duration(audio_path) + 0.8  # brief pause

    cmd = [
        FFMPEG, "-y",
        "-loop", "1",
        "-i", img_path,
        "-i", audio_path,
        "-c:v", "libx264",
        "-tune", "stillimage",
        "-c:a", "aac",
        "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
        "-t", str(duration),
        "-shortest",
        "-preset", "ultrafast",
        clip_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ERROR slide {slide_num}: {result.stderr[-200:]}")
        return False
    print(f"  Slide {slide_num}: {duration:.1f}s")
    return True


def concat_clips(clip_paths, output):
    """Concatenate all clips into final video."""
    # Create concat file
    concat_file = os.path.join(CLIPS_DIR, "concat.txt")
    with open(concat_file, "w") as f:
        for p in clip_paths:
            f.write(f"file '{p}'\n")

    cmd = [
        FFMPEG, "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_file,
        "-c:v", "libx264",
        "-c:a", "aac",
        "-b:a", "192k",
        "-preset", "fast",
        "-movflags", "+faststart",
        output
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  CONCAT ERROR: {result.stderr[-300:]}")
        return False
    return True


if __name__ == "__main__":
    print("=" * 50)
    print("  Video Generator (ffmpeg direct)")
    print("=" * 50)

    # Check all files exist
    for i in range(1, 14):
        img = os.path.join(SLIDES_DIR, f"slide_{i:02d}.png")
        aud = os.path.join(AUDIO_DIR, f"slide_{i:02d}.mp3")
        if not os.path.exists(img):
            print(f"MISSING: {img}")
        if not os.path.exists(aud):
            print(f"MISSING: {aud}")

    # Remove old output
    if os.path.exists(OUTPUT):
        os.remove(OUTPUT)

    # Step 1: Create individual clips
    print("\nCreating clips...")
    clip_paths = []
    for i in range(1, 14):
        img = os.path.join(SLIDES_DIR, f"slide_{i:02d}.png")
        aud = os.path.join(AUDIO_DIR, f"slide_{i:02d}.mp3")
        clip = os.path.join(CLIPS_DIR, f"clip_{i:02d}.mp4")
        if create_clip(i, img, aud, clip):
            clip_paths.append(clip)

    # Step 2: Concatenate
    print(f"\nConcatenating {len(clip_paths)} clips...")
    if concat_clips(clip_paths, OUTPUT):
        size_mb = os.path.getsize(OUTPUT) / 1024 / 1024
        print(f"\nDone! Saved: {OUTPUT}")
        print(f"File size: {size_mb:.1f} MB")
    else:
        print("\nFailed to create final video.")
