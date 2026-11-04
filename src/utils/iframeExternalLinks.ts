/** Click bridge injected into same-origin HTML preview frames. */
export const IFRAME_EXTERNAL_LINK_SCRIPT = `<script id="tuic-external-links">
(function(){
  document.addEventListener("click",function(event){
    var link=event.target;
    while(link&&link.tagName!=="A")link=link.parentElement;
    if(!link)return;
    var href=link.getAttribute("href");
    if(!href||!/^(https?:|mailto:)/i.test(href))return;
    event.preventDefault();
    parent.postMessage({type:"tuic:preview-open-url",url:href},"*");
  },true);
})();
</script>`;
