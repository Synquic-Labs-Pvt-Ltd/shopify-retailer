Create one brand-new photorealistic photograph for an online store: a wholesome, family-friendly catalog image for a general audience, made to sell the product on a product page and in ads. Any person is a calm, fully clothed adult model in a relaxed, natural, professional pose.

This is a fresh photoshoot, NOT an edit or a copy of the input photos. Build a completely new image from the shot below: a new pose, camera angle, framing, background and lighting. Never reproduce the pose, crop, background, mannequin or flat-lay of a product image, and never output a plain cut-out or packshot unless the shot asks for one.

Input images: STYLE REFERENCE images show the scene to recreate (setting, set dressing and props, color palette, grading, lighting, mood); stage similar props so the photo belongs to the same shoot. PRODUCT IMAGE images show the exact garment from different views and are the ground truth for its appearance. Take the outfit from the PRODUCT IMAGES and place it on the model in the scene. A style reference never shows the product: it supplies neither the product, the person, clothing, brand names, logos nor readable text.

Shot: {{shot.prompt}}
Camera and framing: {{shot.camera}}
Lighting: {{shot.lighting}}
People: {{shot.people}}

Garment (highest priority): reproduce the product exactly as in the PRODUCT IMAGES: shape, proportions, colors, materials, textures, prints, printed text, logos, labels, hardware and stitching. Preserve: {{plan.product.mustPreserve}}. Every garment and accessory visible on the model in the PRODUCT IMAGES appears exactly as shown there, with the same cut, length, neckline, sleeves, fabric, colors, pattern and trims. Do not change the dress, swap the top or bottom, replace the shoes, or add any garment that is not in the PRODUCT IMAGES; a piece that no PRODUCT IMAGE shows is a plain, solid-color neutral basic that stays secondary. The scene's light adds natural shading and reflections only and never shifts the product's true colors. Clothing seen on people in the STYLE REFERENCES is never used.

Framing and focus: the product is the clear hero at realistic scale with correct contact shadows. The whole frame is in deep focus, crisp from the model to the farthest part of the backdrop, with a sharp, detailed background. Frame a full look head to toe (or three-quarter) with natural headroom and the whole outfit inside the frame; never cut off the head, hands or feet. Use a tight crop only when the shot explicitly calls for a detail.

Output: a single image, {{image.aspectRatio}} aspect ratio, high detail, commercial quality, rich and polished. A clean frame with only the scene itself in it: no text, captions, watermark, added logos, borders, collage or split screen.

Avoid: {{shot.negative}}, bokeh, blurred background, shallow depth of field, distorted product, changed or substituted garment, warped text or logo, duplicate products, extra fingers, cartoon or CGI look, flat lifeless lighting, a plain copy of the product photo, awkwardly cropped head or limbs.
