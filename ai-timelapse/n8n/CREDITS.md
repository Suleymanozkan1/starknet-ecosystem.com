# Credits

The workflow JSON files in this directory are the **AI Construction Timelapse
Generator** template by **Alex Safari**, imported unmodified from
<https://github.com/Alex-safari/AI-Timelapse-Video>.

- Author: Alex Safari - <https://loopsera.com>
- YouTube: <https://www.youtube.com/@alexsafari1>
- Setup walkthrough: <https://youtu.be/lYkVvQAg5l4>

| File | Upstream name | Role |
| --- | --- | --- |
| `01-part1-generate.json` | `workflow_part1_generate (2).json` | Main workflow: reads the Airtable queue, generates the middle frame, the three video prompts, the clips and the music. |
| `02-part2-webhook-stitcher.json` | `workflow_part2_webhook_stitcher.json` | Webhook-driven stitcher that assembles the final video. |
| `03-fal-nanobanana2-image-to-image.json` | `Fal.ai nanobanana2 image to image edit.json` | Subworkflow: image-to-image edit that produces the bridge frame. |
| `04-kie-veo31-image-to-video.json` | `Kie.ai VEO3.1 fast image to video subworkflow.json` | Subworkflow: Veo 3.1 fast, first-and-last-frames to video. |
| `05-shotstack-stitch.json` | `updated_shotstack_workflow.json` | Subworkflow: Shotstack edit that muxes clips and music. |

Only the filenames were changed, so import order is obvious. The node graphs
are untouched.
