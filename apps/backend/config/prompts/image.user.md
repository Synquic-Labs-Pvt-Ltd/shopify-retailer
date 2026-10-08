Create one photorealistic lifestyle photograph for an online store: a wholesome, family-friendly catalog image for a general audience. Any person is a calm, fully clothed adult model in a relaxed, natural, professional pose.

Image roles: images labeled PRODUCT IMAGE are the exact product to feature, shown from different views; together they are the ground truth for its appearance. Images labeled STYLE REFERENCE only define setting, lighting, color grading and mood. A style reference never shows the product: do not copy any garment, outfit, shoes, accessory, object, product, person, logo or text from it, even if it looks similar to the product.

Shot: {{shot.prompt}}
Camera and framing: {{shot.camera}}
Lighting: {{shot.lighting}}
People: {{shot.people}}

Product fidelity (highest priority): reproduce the product exactly as in the PRODUCT IMAGES, with the same shape, proportions, colors, materials, textures, prints, printed text, logos, labels, hardware and stitching. Preserve: {{plan.product.mustPreserve}}. Do not add, remove, simplify or redesign any part. Scene lighting may add natural shading and reflections only; never shift the product's true colors.

Outfit fidelity (when a person wears the product): every garment and accessory visible on the model in the PRODUCT IMAGES appears exactly as shown there, with the same cut, length, neckline, sleeves, fabric, exact colors, pattern and trims. Do not change the dress, swap the top or bottom, replace the shoes, or add any garment that is not in the PRODUCT IMAGES. Only if a piece is not visible in any PRODUCT IMAGE, use a plain, solid-color, neutral basic that stays clearly secondary and unobtrusive. Clothing seen on people in the STYLE REFERENCES is never used.

Composition: the product is the clear hero, in sharp focus, at realistic scale, with correct contact shadows, and fully inside the frame unless the shot says otherwise.

Output: a single image, {{image.aspectRatio}} aspect ratio, high detail, commercial quality. No text, no captions, no watermark, no added logos, no borders, no collage, no split screen.

Avoid: {{shot.negative}}, distorted product, changed or substituted garment, different bottom or top than in the product images, warped text or logo, duplicate products, extra fingers, cartoon or CGI look.
