Create one photorealistic lifestyle photograph for an online store.

Image roles: images labeled PRODUCT IMAGE are the exact product to feature and are the ground truth for its appearance. Images labeled STYLE REFERENCE only define setting, lighting, color grading and mood; do not copy any object, product, person, logo or text from them.

Shot: {{shot.prompt}}
Camera and framing: {{shot.camera}}
Lighting: {{shot.lighting}}
People: {{shot.people}}

Product fidelity (highest priority): reproduce the product exactly as in the PRODUCT IMAGES, with the same shape, proportions, colors, materials, textures, printed text, logos, labels, hardware and stitching. Preserve: {{plan.product.mustPreserve}}. Do not add, remove, simplify or redesign any part. Scene lighting may add natural shading and reflections only; never shift the product's true colors.

Composition: the product is the clear hero, in sharp focus, at realistic scale, with correct contact shadows, and fully inside the frame unless the shot says otherwise.

Output: a single image, {{image.aspectRatio}} aspect ratio, high detail, commercial quality. No text, no captions, no watermark, no added logos, no borders, no collage, no split screen.

Avoid: {{shot.negative}}, distorted product, warped text or logo, duplicate products, extra fingers, cartoon or CGI look.
