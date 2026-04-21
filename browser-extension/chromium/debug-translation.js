// Diagnostic script to check if we can access Google Translate widget values
// Run this in the browser console on a Google Translate page to inspect the DOM

console.log('=== Google Translate Widget DOM Inspection ===');

// Check 1: Look for translation widget container
const translationWidget = document.querySelector('[data-attrid*="translation"]') || 
                         document.querySelector('[data-attrid="kc:/language/translation:translate_text"]') ||
                         document.querySelector('.tw-container');

console.log('1. Translation widget container:', translationWidget);

if (translationWidget) {
  // Check 2: Look for all textareas
  const allTextareas = translationWidget.querySelectorAll('textarea');
  console.log('2. Textareas found:', allTextareas.length);
  allTextareas.forEach((ta, i) => {
    console.log(`   Textarea ${i}:`, {
      value: ta.value,
      textContent: ta.textContent,
      readonly: ta.hasAttribute('readonly'),
      disabled: ta.hasAttribute('disabled'),
      placeholder: ta.placeholder,
      className: ta.className,
    });
  });
  
  // Check 3: Look for input elements
  const allInputs = translationWidget.querySelectorAll('input');
  console.log('3. Inputs found:', allInputs.length);
  allInputs.forEach((input, i) => {
    console.log(`   Input ${i}:`, {
      value: input.value,
      type: input.type,
      readonly: input.hasAttribute('readonly'),
      className: input.className,
    });
  });
  
  // Check 4: Look for divs/spans that might contain text
  const allDivs = translationWidget.querySelectorAll('div, span');
  console.log('4. Divs/spans found:', allDivs.length);
  const textContainers = Array.from(allDivs).filter(el => {
    const text = (el.textContent || '').trim();
    return text.length > 0 && text.length < 200; // Reasonable text length
  });
  console.log('   Text containers (first 10):', textContainers.slice(0, 10).map(el => ({
    tagName: el.tagName,
    text: el.textContent.trim().substring(0, 50),
    className: el.className,
    id: el.id,
  })));
  
  // Check 5: Check for iframes (translation might be in iframe)
  const iframes = translationWidget.querySelectorAll('iframe');
  console.log('5. Iframes found:', iframes.length);
  iframes.forEach((iframe, i) => {
    console.log(`   Iframe ${i}:`, {
      src: iframe.src,
      contentDocument: iframe.contentDocument ? 'accessible' : 'not accessible (cross-origin)',
    });
  });
  
  // Check 6: Check for Shadow DOM
  const shadowHosts = Array.from(translationWidget.querySelectorAll('*')).filter(el => el.shadowRoot);
  console.log('6. Shadow DOM hosts found:', shadowHosts.length);
  shadowHosts.forEach((host, i) => {
    console.log(`   Shadow host ${i}:`, {
      tagName: host.tagName,
      className: host.className,
      shadowContent: host.shadowRoot ? 'has shadow root' : 'no shadow root',
    });
  });
  
  // Check 7: Look for specific Google Translate classes
  const twElements = translationWidget.querySelectorAll('[class*="tw-"]');
  console.log('7. Elements with "tw-" classes:', twElements.length);
  twElements.forEach((el, i) => {
    if (i < 10) { // Limit output
      console.log(`   Element ${i}:`, {
        tagName: el.tagName,
        className: el.className,
        text: (el.textContent || '').trim().substring(0, 50),
      });
    }
  });
  
  // Check 8: Try to find source and target text specifically
  console.log('8. Looking for Korean text (source):');
  const koreanText = Array.from(allDivs).find(el => {
    const text = (el.textContent || '').trim();
    return /[가-힣]/.test(text) && text.length < 100; // Contains Korean characters
  });
  console.log('   Korean text element:', koreanText ? {
    text: koreanText.textContent.trim(),
    className: koreanText.className,
  } : 'not found');
  
  console.log('9. Looking for English text (target):');
  const englishText = Array.from(allDivs).find(el => {
    const text = (el.textContent || '').trim();
    return /^[A-Za-z\s\.,!?]+$/.test(text) && text.length > 5 && text.length < 100; // English only
  });
  console.log('   English text element:', englishText ? {
    text: englishText.textContent.trim(),
    className: englishText.className,
  } : 'not found');
  
  // Check 10: Full DOM structure (limited depth)
  console.log('10. Widget structure (first level children):');
  Array.from(translationWidget.children).slice(0, 10).forEach((child, i) => {
    console.log(`   Child ${i}:`, {
      tagName: child.tagName,
      className: child.className,
      id: child.id,
      textContent: (child.textContent || '').trim().substring(0, 100),
    });
  });
}

// Check if widget is in iframe at page level
const pageIframes = document.querySelectorAll('iframe');
console.log('11. Page-level iframes:', pageIframes.length);
pageIframes.forEach((iframe, i) => {
  try {
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    const iframeTranslation = iframeDoc.querySelector('[data-attrid*="translation"]');
    console.log(`   Iframe ${i}:`, {
      src: iframe.src,
      accessible: iframeDoc ? 'yes' : 'no (cross-origin)',
      hasTranslation: iframeTranslation ? 'yes' : 'no',
    });
  } catch (e) {
    console.log(`   Iframe ${i}:`, {
      src: iframe.src,
      accessible: 'no (cross-origin)',
      error: e.message,
    });
  }
});

console.log('=== End of Inspection ===');

